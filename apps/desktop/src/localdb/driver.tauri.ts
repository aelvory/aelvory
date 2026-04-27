import Database from '@tauri-apps/plugin-sql';
import type { DbDriver, ExecuteResult } from './driver';

/**
 * Tauri implementation of DbDriver, on top of @tauri-apps/plugin-sql.
 *
 * The plugin's `execute`/`select` are async over IPC, so we want to keep
 * round-trips low — handlers should batch where possible.
 *
 * Transactions: plugin-sql does NOT expose savepoints/begin/commit as a
 * scoped API. We emulate via raw `BEGIN`/`COMMIT`/`ROLLBACK` statements.
 * That's fine because we never run concurrent connections; the plugin
 * pools per-DB-URL and our app uses a single URL.
 */
export class TauriDbDriver implements DbDriver {
  private inTx = 0;

  constructor(private readonly db: Database) {}

  static async load(url: string): Promise<TauriDbDriver> {
    const db = await Database.load(url);
    const driver = new TauriDbDriver(db);
    // PRAGMAs we always want.
    await driver.execute('PRAGMA foreign_keys = ON');
    await driver.execute('PRAGMA journal_mode = WAL');
    // busy_timeout: if another writer holds the lock, wait up to 5s for
    // it to release before raising SQLITE_BUSY. Without this, a wipe
    // racing an in-flight sync write fails immediately with "database
    // is locked". 5s is generous — sync writes are sub-second — but
    // cheap, since we only block when there's actual contention.
    await driver.execute('PRAGMA busy_timeout = 5000');
    return driver;
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
    const r = await this.db.execute(sql, params as any);
    return { rowsAffected: r.rowsAffected ?? 0, lastInsertId: r.lastInsertId };
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.db.select<T[]>(sql, params as any)) ?? [];
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

    this.inTx = 1;
    await this.db.execute('BEGIN');
    try {
      const result = await fn();
      await this.db.execute('COMMIT');
      return result;
    } catch (err) {
      try {
        await this.db.execute('ROLLBACK');
      } catch {
        /* swallow — the original error is what matters */
      }
      throw err;
    } finally {
      this.inTx = 0;
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
