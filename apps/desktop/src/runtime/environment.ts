/**
 * Runtime environment detection.
 *
 * The app targets multiple shells:
 *  - Tauri desktop (today)        -> tauri-plugin-sql + tauri-plugin-http
 *  - VSCode extension (future)    -> message bridge to extension host
 *                                    (extension host owns the SQLite file
 *                                    via better-sqlite3, webview is UI-only)
 *  - Plain browser (escape hatch) -> sql.js / wa-sqlite + fetch (CORS applies)
 *
 * Anything platform-specific in the data or transport layer asks here once
 * and branches. UI code MUST NOT branch on environment — it goes through
 * api()/dispatchLocal() and the runner, both of which are environment-aware.
 */

export type Runtime = 'tauri' | 'vscode' | 'browser';

let cached: Runtime | null = null;

export function detectRuntime(): Runtime {
  if (cached) return cached;
  if (typeof window === 'undefined') {
    cached = 'browser';
    return cached;
  }

  if (
    '__TAURI_INTERNALS__' in window ||
    '__TAURI__' in window ||
    '__TAURI_METADATA__' in window
  ) {
    cached = 'tauri';
    return cached;
  }

  // VSCode webviews expose `acquireVsCodeApi` exactly once. We don't call it
  // here (that consumes it); presence is enough.
  if (typeof (window as any).acquireVsCodeApi === 'function') {
    cached = 'vscode';
    return cached;
  }

  cached = 'browser';
  return cached;
}

export function isTauriEnv(): boolean {
  return detectRuntime() === 'tauri';
}

export function isVSCodeEnv(): boolean {
  return detectRuntime() === 'vscode';
}

export function isBrowserEnv(): boolean {
  return detectRuntime() === 'browser';
}
