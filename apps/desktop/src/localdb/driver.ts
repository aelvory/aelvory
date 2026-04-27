/**
 * DbDriver — the single boundary between our SQL handlers and the underlying
 * SQLite binding. Two drivers implement this:
 *
 *   driver.tauri.ts  -> @tauri-apps/plugin-sql (Tauri desktop build)
 *   driver.sqljs.ts  -> sql.js WebAssembly (VSCode webview build; the host
 *                       just owns the on-disk file and proxies bytes)
 *
 * Keep this surface tiny. SQL strings travel through unchanged so the schema
 * is portable; only the binding layer differs per host.
 *
 * Conventions:
 *  - Use `?` placeholders. Tauri's plugin-sql translates these for sqlite.
 *    sql.js also accepts `?`. Stay portable.
 *  - `select` returns rows as plain objects keyed by column name.
 *  - `transaction` MUST run sequentially; nesting is not supported.
 */

export interface ExecuteResult {
  rowsAffected: number;
  lastInsertId?: number;
}

export interface DbDriver {
  /** Execute a non-SELECT statement (INSERT/UPDATE/DELETE/DDL). */
  execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;

  /** Execute a SELECT and return rows. */
  select<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  /** Run `fn` inside a single SQLite transaction. Auto-rollback on throw. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  /** Close the underlying connection. Optional; mainly for tests. */
  close?(): Promise<void>;
}

/**
 * Schema version this build expects. Bump when a migration is added; the
 * migration runner then knows which SQL files still need to apply.
 */
export const SCHEMA_VERSION = 1;
