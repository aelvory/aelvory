/**
 * sql.js implementation of DbDriver. Used inside the VSCode extension
 * webview, where we can't (sensibly) load a native SQLite binding —
 * the better-sqlite3 path required matching VSCode's exact Electron
 * NODE_MODULE_VERSION, which broke on every VSCode upgrade.
 *
 * sql.js is pure WebAssembly: same `.vsix` works on every platform
 * and survives Electron version bumps without recompiling. The trade
 * is ~3-5× slower for bulk writes — fine for an API-testing tool's
 * local cache, where the largest realistic transaction is a project
 * sync of a few hundred rows (sub-second either way).
 *
 * Persistence model:
 *   - sql.js keeps the entire DB in RAM as a Uint8Array.
 *   - On every write, we mark the in-memory image dirty and schedule
 *     a debounced flush (FLUSH_DELAY_MS).
 *   - The flush calls `persist(bytes)` — the host writes the bytes
 *     to disk atomically (tmp + rename) via the postMessage bridge.
 *   - On close(), any pending flush is awaited so we never lose the
 *     last edit.
 *
 * The on-disk format is identical to a normal SQLite file, so an
 * existing `aelvory.db` from the better-sqlite3 era loads as-is —
 * no migration / conversion needed.
 */

import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import type { DbDriver, ExecuteResult } from './driver';

// Vite's `define` (see vite.config.vscode.ts) replaces this token
// with the base64-encoded WASM bytes at build time, so the runtime
// has no asset URL to fetch and no CSP fetch/wasm rules to navigate.
declare const __SQL_JS_WASM_BASE64__: string;

const FLUSH_DELAY_MS = 500;

let sqlJsModule: SqlJsStatic | null = null;

async function loadSqlJs(): Promise<SqlJsStatic> {
  if (sqlJsModule) return sqlJsModule;
  // base64 → Uint8Array. atob is fine here: the bundle string is
  // pure ASCII (well under the ~50 MB string-length limit) and the
  // 1.4 MB decode happens once at startup.
  const binary = Uint8Array.from(atob(__SQL_JS_WASM_BASE64__), (c) =>
    c.charCodeAt(0),
  );
  sqlJsModule = await initSqlJs({ wasmBinary: binary });
  return sqlJsModule;
}

export interface SqlJsDbDriverOptions {
  /** Initial DB bytes — null/empty means start with an empty database. */
  initial: Uint8Array | null;
  /** Called with the serialised DB after every batch of writes settles. */
  persist: (bytes: Uint8Array) => Promise<void>;
}

export class SqlJsDbDriver implements DbDriver {
  private inTx = 0;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;

  private constructor(
    private readonly db: Database,
    private readonly persist: (bytes: Uint8Array) => Promise<void>,
  ) {}

  static async load(opts: SqlJsDbDriverOptions): Promise<SqlJsDbDriver> {
    const SQL = await loadSqlJs();
    const db =
      opts.initial && opts.initial.byteLength > 0
        ? new SQL.Database(opts.initial)
        : new SQL.Database();
    db.run('PRAGMA foreign_keys = ON');
    return new SqlJsDbDriver(db, opts.persist);
  }

  async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
    // sql.js's `run(sql, params)` only handles a single statement;
    // the migration runner already splits multi-stmt scripts via
    // `db.exec` semantics — we route those through `db.exec` below
    // when params are absent. With params, single-stmt is the only
    // sensible shape anyway.
    if (params.length === 0 && /;\s*\S/.test(sql.replace(/--.*$/gm, ''))) {
      this.db.exec(sql);
    } else {
      this.db.run(sql, params as never);
    }
    const rowsAffected = this.db.getRowsModified();
    this.markDirty();
    // sql.js doesn't expose lastInsertRowid as a single accessor; we'd
    // have to follow with `SELECT last_insert_rowid()`. Our schema uses
    // application-generated string IDs everywhere, so this is unused —
    // leave it `undefined` rather than pay the extra round-trip.
    return { rowsAffected };
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    try {
      if (params.length > 0) stmt.bind(params as never);
      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTx > 0) {
      // Nested — flatten. SQLite has SAVEPOINTs but we don't need
      // partial rollback today and avoiding them keeps parity with
      // the Tauri driver's semantics.
      this.inTx++;
      try {
        return await fn();
      } finally {
        this.inTx--;
      }
    }
    this.inTx = 1;
    this.db.run('BEGIN');
    try {
      const result = await fn();
      this.db.run('COMMIT');
      this.markDirty();
      return result;
    } catch (err) {
      try {
        this.db.run('ROLLBACK');
      } catch {
        /* original error is what matters */
      }
      throw err;
    } finally {
      this.inTx = 0;
    }
  }

  async close(): Promise<void> {
    // Drain any pending flush so the very last write isn't lost on
    // window-close / extension-deactivate.
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      await this.flushNow();
    } else if (this.inflight) {
      await this.inflight;
    }
    this.db.close();
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, FLUSH_DELAY_MS);
  }

  private async flushNow(): Promise<void> {
    if (this.inflight) {
      // Coalesce: chain after the in-flight write so we don't
      // serialise concurrent flushes into the host bridge.
      await this.inflight;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const bytes = this.db.export();
    this.inflight = (async () => {
      try {
        await this.persist(bytes);
      } catch (err) {
        // Re-mark so the next markDirty() schedules a retry.
        this.dirty = true;
        // Swallow vs throw: this runs from a setTimeout so throwing
        // hits the Promise rejection handler with no caller. Logging
        // is more useful than a silent failure.
        console.error('[sqljs] persist failed:', err);
      } finally {
        this.inflight = null;
      }
    })();
    await this.inflight;
  }
}
