/**
 * Single-acquisition handle to the VS Code webview API.
 *
 * `window.acquireVsCodeApi()` MUST be called exactly once per
 * webview — the second call throws "An instance of the VS Code API
 * has already been acquired". Multiple modules in the webview need
 * to send messages (the DB bridge, the HTTP/saveAs/db.read/db.write
 * helpers, the WebSocket proxy), so we centralise the acquisition
 * here and hand out the same VsCodeApi instance to every caller.
 *
 * This module is the only place in the webview that should ever
 * touch `window.acquireVsCodeApi`.
 */

interface VsCodeApi {
  postMessage(msg: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

let cached: VsCodeApi | null = null;

export function getVsCodeApi(): VsCodeApi {
  if (cached) return cached;
  const acquire = window.acquireVsCodeApi;
  if (typeof acquire !== 'function') {
    throw new Error('acquireVsCodeApi unavailable — not in a VSCode webview');
  }
  cached = acquire();
  return cached;
}
