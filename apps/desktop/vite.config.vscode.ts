/**
 * Build the desktop Vue app for embedding in the VSCode extension's
 * webview. The differences vs the Tauri build:
 *
 *  - `base: './'` → all asset URLs in the emitted index.html are
 *    relative. The extension's `renderHtml()` rewrites them
 *    through `webview.asWebviewUri()` so they pass the webview's
 *    Content-Security-Policy. Absolute paths (`/assets/...`) would
 *    resolve to the webview's vscode-webview:// origin and 404.
 *
 *  - Output goes to `../vscode-extension/media/webview/`. The extension
 *    bundles this directory at package time.
 *
 *  - We explicitly inline assets below 4 KB because every webview
 *    request adds ~50 ms over the message channel; small fonts /
 *    favicons inlined into the bundle save round-trips.
 *
 * The runtime decides Tauri vs VSCode at boot via
 * `runtime/environment.ts` (presence of `acquireVsCodeApi`), so the
 * same source compiles once and behaves correctly in both shells.
 */
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Inline sql.js's WASM as a base64 string at build time. The webview's
// CSP, the lack of `webview.asWebviewUri` from inside JS, and the
// absence of cross-origin-isolation all conspire to make fetching the
// .wasm at runtime brittle. Embedding it sidesteps every one of those:
// the compiled JS contains the bytes, sql.js calls
// `WebAssembly.instantiate(buffer)` directly, no network involved.
//
// Cost: ~1.4 MB native → ~1.9 MB base64 string in the bundle. The
// previous better-sqlite3 path shipped 1.8 MB native too — net wash.
const requireFromHere = createRequire(import.meta.url);
const sqlJsWasm = readFileSync(
  requireFromHere.resolve('sql.js/dist/sql-wasm.wasm'),
).toString('base64');

export default defineConfig({
  plugins: [vue()],
  base: './',
  define: {
    __SQL_JS_WASM_BASE64__: JSON.stringify(sqlJsWasm),
  },
  build: {
    outDir: '../vscode-extension/media/webview',
    emptyOutDir: true,
    sourcemap: false,
    // Inline anything ≤4 KB to cut webview round-trips. Vite's
    // default is 4096 — being explicit so a future config refactor
    // doesn't accidentally raise it (which would inflate the
    // initial JS payload — bad for webview cold-start).
    assetsInlineLimit: 4096,
    // Vue + PrimeVue + CodeMirror legitimately produce a ~600 KB
    // bundle; the default 500 KB warning is just noise for an app
    // that isn't network-delivered (webview loads from disk via
    // `webview.asWebviewUri`, not over a slow network). Splitting
    // further would only add cold-start round-trips. Bump to silence.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Stable chunk names make Content-Security-Policy and
        // `webview.asWebviewUri` rewriting easier to debug. Hash
        // is still in the filename for cache-busting.
        assetFileNames: 'assets/[name]-[hash][extname]',
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  envPrefix: ['VITE_'],
});
