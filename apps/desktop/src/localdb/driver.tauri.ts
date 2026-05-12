import Database from '@tauri-apps/plugin-sql';
import type { DbDriver, ExecuteResult } from './driver';

/**
 * Tauri implementation of DbDriver, on top of @tauri-apps/plugin-sql.
 *
 * The plugin's `execute`/`select` are async over IPC, so we want to keep
 * round-trips low — handlers should batch where possible.
 *
 * Concurrency model. plugin-sql sits on an sqlx connection pool, and
 * each `execute` call acquires + releases a connection — it never
 * pins one. That makes raw `BEGIN`/`COMMIT` unreliable: a `BEGIN
 * IMMEDIATE` grabs the write lock on connection A, sqlx puts A back
 * in the pool, and the next `UPDATE` lands on connection B which
 * then collides with A's lock and fails with SQLITE_BUSY. There's
 * no public knob to force a single-connection pool.
 *
 * Workaround: drop SQL-level transactions entirely. We serialize all
 * writes through a JS promise-chain mutex so two writes never overlap
 * at the SQLite level — at most one statement is in flight at a time,
 * so there's no contention to lose. `transaction(fn)` becomes "run
 * fn while holding the mutex"; the contained statements behave as a
 * single atomic block from the perspective of every other caller in
 * this process. The cost is that if one statement inside fn throws,
 * earlier ones aren't rolled back — for our use cases (sortIndex
 * rebalancing, batch upserts) partial failure is recoverable on the
 * next operation, so this trade-off is fine.
 */
export class TauriDbDriver implements DbDriver {
  private inTx = 0;
  /** Serializes top-level transactions and standalone writes. */
  private txChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: Database) {}

  static async load(url: string): Promise<TauriDbDriver> {
    const db = await Database.load(url);
    const driver = new TauriDbDriver(db);
    // foreign_keys is per-connection but cheap; journal_mode=WAL is
    // database-wide and persistent.
    await driver.execute('PRAGMA foreign_keys = ON');
    await driver.execute('PRAGMA journal_mode = WAL');
    // busy_timeout is PER-CONNECTION. plugin-sql uses an sqlx pool
    // (default ~10 connections), so running this PRAGMA once only
    // configures whichever connection happened to handle the call —
    // all other pool connections start with busy_timeout=0 and fail
    // immediately on contention with "database is locked".
    //
    // Workaround: blast the PRAGMA out in parallel so sqlx is forced
    // to spin up every pool connection at once and each gets the
    // setting. Subsequent operations inherit it from whichever idle
    // connection they grab. 20 covers any reasonable pool size and
    // any extras just no-op on already-configured connections.
    await Promise.all(
      Array.from({ length: 20 }, () =>
        driver.db.execute('PRAGMA busy_timeout = 10000'),
      ),
    );
    return driver;
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
    // Inside a transaction: we're already holding the mutex via the
    // surrounding `transaction()` chain — bypass to avoid deadlock.
    if (this.inTx > 0) {
      const r = await this.db.execute(sql, params as any);
      return { rowsAffected: r.rowsAffected ?? 0, lastInsertId: r.lastInsertId };
    }
    // Standalone write: serialize through the chain so it can't collide
    // with a transaction running on a different pool connection.
    return this.queue(async () => {
      const r = await this.db.execute(sql, params as any);
      return { rowsAffected: r.rowsAffected ?? 0, lastInsertId: r.lastInsertId };
    });
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    // Reads don't need to serialize — WAL allows concurrent readers
    // and they never take the write lock.
    return (await this.db.select<T[]>(sql, params as any)) ?? [];
  }

  /** Append work onto the write chain so it runs after any prior writer. */
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.txChain.then(() => fn());
    this.txChain = next.catch(() => {});
    return next;
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTx > 0) {
      // Nested call — flatten. SQLite has SAVEPOINT but we don't need the
      // partial-rollback semantics today.
      this.inTx++;
      try {
        return await fn();
      } finally {
        this.inTx--;
      }
    }

    // Just hold the mutex for the duration of `fn` — every statement
    // it issues queues onto our chain instead of fighting for the
    // SQLite write lock across pool connections. No SQL-level
    // BEGIN/COMMIT, see the class docstring for why.
    return this.queue(async () => {
      this.inTx = 1;
      try {
        return await fn();
      } finally {
        this.inTx = 0;
      }
    });
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
