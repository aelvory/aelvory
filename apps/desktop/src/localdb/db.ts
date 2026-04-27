/**
 * The single SQLite handle for the app. Lazy-initialized; the first call to
 * getDb() loads the right driver for the current runtime, runs migrations,
 * and (one-shot) imports legacy Dexie data if present.
 */

import { detectRuntime } from '@/runtime/environment';
import type { DbDriver } from './driver';
import { applyMigrations } from './migrations';

const DB_URL = 'sqlite:aelvory.db';

let driverPromise: Promise<DbDriver> | null = null;

async function loadDriver(): Promise<DbDriver> {
  const rt = detectRuntime();
  if (rt === 'tauri') {
    const { TauriDbDriver } = await import('./driver.tauri');
    return TauriDbDriver.load(DB_URL);
  }
  if (rt === 'vscode') {
    // sql.js (WASM) runs entirely in the webview. The host owns the
    // file — we just ask it for the bytes once on boot, and post
    // updated bytes back after every batch of writes settles. This
    // replaces the earlier better-sqlite3 path, which broke whenever
    // VSCode's Electron NODE_MODULE_VERSION shifted.
    const [{ SqlJsDbDriver }, { vsDbRead, vsDbWrite }] = await Promise.all([
      import('./driver.sqljs'),
      import('@/services/vscodeBridge'),
    ]);
    const initial = await vsDbRead();
    return SqlJsDbDriver.load({
      initial,
      persist: vsDbWrite,
    });
  }
  // Browser fallback: not implemented yet. Would reuse the sql.js
  // driver but persist via OPFS / IndexedDB instead of the host bridge.
  throw new Error(
    `No SQLite driver registered for runtime "${rt}". ` +
      'This build expects to run inside Tauri or VSCode.',
  );
}

export async function getDb(): Promise<DbDriver> {
  if (!driverPromise) {
    driverPromise = (async () => {
      const driver = await loadDriver();
      await applyMigrations(driver);
      return driver;
    })();
  }
  return driverPromise;
}

/**
 * Test/teardown helper. Forces the next getDb() to re-init.
 */
export function _resetDbForTests() {
  driverPromise = null;
}
