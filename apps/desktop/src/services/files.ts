/**
 * File-saving abstraction. Three runtimes, three paths:
 *
 *   - **Tauri** — native save dialog + Rust filesystem write.
 *     Programmatic `<a download>` clicks lose user-activation when
 *     triggered from non-webview-originated events (native menu,
 *     etc.) and are silently no-op'd by WebView2/WKWebView, so
 *     this is the only reliable path in Tauri.
 *   - **VSCode extension** — postMessage to the host, where
 *     `vscode.window.showSaveDialog` + `fs.writeFile` do the real
 *     work. See `services/vscodeBridge.ts`.
 *   - **Plain browser** — blob + anchor pattern. Works because the
 *     click happens in user-activation context (Vite dev tab).
 */

import { isTauriEnv, isVSCodeEnv } from '@/runtime/environment';

export interface SaveJsonOptions {
  /** Suggested filename in the Save As dialog. */
  defaultFilename: string;
  /** JSON content to write. Already-stringified — caller controls formatting. */
  content: string;
  /** UI-friendly description for the filter. Defaults to "JSON". */
  filterName?: string;
}

/**
 * Returns the path the file was saved to (Tauri) or the suggested filename
 * (browser), or `null` if the user cancelled.
 */
export async function saveJsonFile(opts: SaveJsonOptions): Promise<string | null> {
  if (isTauriEnv()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');

    const path = await save({
      defaultPath: opts.defaultFilename,
      filters: [
        {
          name: opts.filterName ?? 'JSON',
          extensions: ['json'],
        },
      ],
    });
    if (!path) return null; // user cancelled

    // Tauri 2 returns either a string (older versions) or FilePath object
    // depending on the underlying platform plugin version. writeTextFile
    // accepts both shapes; coerce to string only for the toast/result.
    await writeTextFile(path as never, opts.content);
    return typeof path === 'string' ? path : String(path);
  }

  if (isVSCodeEnv()) {
    const { vsSaveAs } = await import('@/services/vscodeBridge');
    const filterName = opts.filterName ?? 'JSON';
    return vsSaveAs(opts.defaultFilename, opts.content, {
      [filterName]: ['json'],
    });
  }

  // Browser fallback — works in pages with user-activation context.
  const blob = new Blob([opts.content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = opts.defaultFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return opts.defaultFilename;
}
