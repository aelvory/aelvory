/**
 * Aelvory VSCode extension entry point.
 *
 * Owns:
 *   - The on-disk `aelvory.db` SQLite file under
 *     ExtensionContext.globalStorageUri (or storageUri in workspace
 *     scope). The host doesn't OPEN the file — it just reads/writes
 *     bytes on behalf of the webview.
 *   - The webview panel hosting the Vue UI built from apps/desktop
 *     with `vite.config.vscode.ts`.
 *   - The postMessage bridge that exposes db.read / db.write / http.fetch
 *     / fs.saveAs to the webview.
 *
 * The actual SQLite engine runs IN the webview as sql.js (WebAssembly).
 * That sidesteps the better-sqlite3 NODE_MODULE_VERSION matrix that
 * broke whenever VSCode's Electron version changed; one universal
 * .vsix now works on every platform and survives Electron upgrades.
 *
 * Build pipeline:
 *   pnpm --filter aelvory-vscode build
 *     → invokes `pnpm --filter @aelvory/desktop build:vscode`
 *       which emits Vue + assets (with sql.js's WASM inlined as
 *       base64) into `media/webview/`
 *     → then `node esbuild.mjs` for the host code
 *
 * Distribution:
 *   pnpm --filter aelvory-vscode package
 *     → produces a single platform-agnostic .vsix users can
 *       `code --install-extension <vsix>`.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { handleDriverMessage, type BridgeContext } from './bridge';
import { AelvorySidebarProvider, EmptyActionsProvider } from './sidebar';

let panel: vscode.WebviewPanel | undefined;
let bridgeCtx: BridgeContext | undefined;

/**
 * Pick the SQLite location based on the user's `aelvory.storageScope`
 * setting:
 *   - `'global'` (default) — `globalStorageUri/aelvory.db`. Same DB
 *     across every VSCode window. Best when API testing follows
 *     the user.
 *   - `'workspace'` — `storageUri/aelvory.db`. Per-workspace DB so
 *     different projects keep separate collections. `storageUri` is
 *     `undefined` when no folder is open; in that case we fall back
 *     to global with a one-time toast so the user sees what
 *     happened.
 *
 * Both directories are created if missing (storageUri's parent is
 * already created by VSCode the first time it's accessed).
 */
async function resolveDbPath(context: vscode.ExtensionContext): Promise<string> {
  const scope = vscode.workspace
    .getConfiguration('aelvory')
    .get<'global' | 'workspace'>('storageScope', 'global');

  if (scope === 'workspace' && context.storageUri) {
    await fs.promises.mkdir(context.storageUri.fsPath, { recursive: true });
    return path.join(context.storageUri.fsPath, 'aelvory.db');
  }

  if (scope === 'workspace' && !context.storageUri) {
    void vscode.window.showInformationMessage(
      'Aelvory: workspace storage requires an open folder. Falling back to ' +
        'global storage for this session.',
    );
  }

  await fs.promises.mkdir(context.globalStorageUri.fsPath, { recursive: true });
  return path.join(context.globalStorageUri.fsPath, 'aelvory.db');
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const dbPath = await resolveDbPath(context);
  const sidebar = new AelvorySidebarProvider(context);
  bridgeCtx = {
    dbPath,
    sidebar,
    // Forwards WebSocket-proxy events from the host's `ws` instance
    // to the webview. The arrow keeps a live reference to whatever
    // panel exists at event-fire time — closures over `panel`
    // wouldn't, since the binding gets reassigned on each
    // open/dispose cycle.
    postEvent: (event) => {
      panel?.webview.postMessage(event);
    },
  };

  // Re-render the relative timestamps (`Last sync: 3m ago`) at a
  // gentle cadence so they don't go stale while the sidebar sits
  // open. Cheap — just a TreeDataProvider event with no DB or
  // network work.
  const relTick = setInterval(() => sidebar.refresh(), 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(relTick) });

  context.subscriptions.push(
    // Status info — three rows, populated by webview pushes.
    vscode.window.registerTreeDataProvider('aelvory.status', sidebar),
    // Empty tree → triggers the welcome view's button markdown to render.
    vscode.window.registerTreeDataProvider(
      'aelvory.actions',
      new EmptyActionsProvider(),
    ),
    vscode.commands.registerCommand('aelvory.open', () => {
      revealOrCreatePanel(context);
    }),
    vscode.commands.registerCommand('aelvory.syncNow', () => {
      // The webview owns the sync-store state; route the command
      // through a postMessage event so the existing
      // `useSyncStore().sync()` code path runs without a separate
      // host-side reimplementation.
      revealOrCreatePanel(context);
      panel?.webview.postMessage({ kind: 'cmd', cmd: 'sync.now' });
    }),

    /**
     * Right-click an OpenAPI / Postman / Insomnia / HAR file in the
     * Explorer (or its editor tab) → "Open in Aelvory". Reads the
     * file, sniffs the format, opens the panel, posts the contents
     * to the webview which feeds them into the existing import
     * dialog pre-filled.
     *
     * The `uri` argument is provided by the explorer/context menu
     * binding — we treat it defensively (could be undefined when
     * invoked from the command palette without a selection) and
     * fall back to the active editor's document.
     */
    vscode.commands.registerCommand('aelvory.openFile', async (uri?: vscode.Uri) => {
      const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!targetUri) {
        void vscode.window.showWarningMessage(
          'Aelvory: no file selected. Right-click a .har / .yaml / .json file in the Explorer.',
        );
        return;
      }

      // Read as text. VSCode's filesystem API works for remote
      // workspaces (SSH, Codespaces, etc.) too — fs.readFile on
      // the path would only work for local files.
      let content: string;
      try {
        const bytes = await vscode.workspace.fs.readFile(targetUri);
        content = Buffer.from(bytes).toString('utf8');
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Aelvory: couldn't read ${targetUri.fsPath} — ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      const format = detectImportFormat(targetUri.path, content);
      revealOrCreatePanel(context);
      panel?.webview.postMessage({
        kind: 'cmd',
        cmd: 'import',
        format,
        content,
        filename: path.basename(targetUri.fsPath),
      });
    }),

    /**
     * "New curl tab" — opens the panel and tells the webview to
     * spawn a fresh curl tab. Wired from the sidebar action row.
     */
    vscode.commands.registerCommand('aelvory.newCurl', () => {
      revealOrCreatePanel(context);
      panel?.webview.postMessage({ kind: 'cmd', cmd: 'curl.new' });
    }),

    /**
     * "Import file…" — show a file picker, load the bytes, send
     * to the webview's import dialog. Same code path as the
     * Explorer right-click "Open in Aelvory" command, but invoked
     * from the sidebar (no `uri` arg, file picker instead).
     */
    vscode.commands.registerCommand('aelvory.import', async () => {
      const picks = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: {
          'API specs and captures': ['har', 'yaml', 'yml', 'json'],
          'All files': ['*'],
        },
        title: 'Import into Aelvory',
      });
      if (!picks || picks.length === 0) return;
      await vscode.commands.executeCommand('aelvory.openFile', picks[0]);
    }),

    /**
     * Storage-scope changes need a window reload to take effect:
     * the dbPath captured at activation time is what the bridge
     * reads from / writes to, and the webview's sql.js instance
     * was seeded from whatever bytes were on disk then. Hot-swapping
     * mid-session would silently leave the UI showing rows from the
     * previous DB. Prompt the user to reload instead.
     */
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('aelvory.storageScope')) {
        void vscode.window
          .showInformationMessage(
            'Aelvory storage scope changed. Reload the window to apply.',
            'Reload',
          )
          .then((choice) => {
            if (choice === 'Reload') {
              void vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
          });
      }
    }),
  );
}

/**
 * Decide which import-dialog tab to land on based on file extension
 * and a short content peek. The dialog supports tab override, so an
 * incorrect guess is recoverable — but a right guess saves a click.
 *
 * Order matters: extension is the strong signal, content peek is the
 * fallback for ambiguous `.json` (could be OpenAPI spec, Postman
 * collection, Insomnia export, or HAR).
 */
function detectImportFormat(filePath: string, content: string): 'openapi' | 'postman' | 'insomnia' | 'har' {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.har') return 'har';
  if (ext === '.yaml' || ext === '.yml') return 'openapi';

  // .json (or unknown) — peek at the first ~1 KB. Each format has
  // a distinctive top-level key set, so substring matching is
  // enough; a real parse would be wasteful and might fail on
  // partially-loaded large files.
  const head = content.slice(0, 2048);
  if (/"_type"\s*:\s*"export"/.test(head)) return 'insomnia';
  if (/"openapi"\s*:\s*"3/.test(head) || /"swagger"\s*:\s*"2/.test(head)) return 'openapi';
  if (/"info"\s*:[^}]*"schema"\s*:[^}]*postman/i.test(head)) return 'postman';
  if (/"log"\s*:\s*\{[\s\S]*"entries"/.test(head)) return 'har';
  // Fallback: OpenAPI is the most common file users have on disk.
  return 'openapi';
}

export function deactivate(): void {
  panel?.dispose();
  panel = undefined;
  bridgeCtx = undefined;
}

function revealOrCreatePanel(context: vscode.ExtensionContext) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    return;
  }

  // localResourceRoots is a security boundary: the webview can ONLY
  // load resources from these directories via webview.asWebviewUri.
  // Pointing at `media/` (which contains the bundled Vue app)
  // matches the asset paths Vite emits.
  const mediaRoot = vscode.Uri.file(path.join(context.extensionPath, 'media'));

  panel = vscode.window.createWebviewPanel(
    'aelvory',
    'Aelvory',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      // Without this, the webview tears down its DOM every time the
      // user switches tabs in VSCode and rebuilds from scratch on
      // return — the SQLite handle, sync state, and any in-progress
      // request edits would be lost. We retain so the desktop's
      // Pinia stores keep their state across tab switches.
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot],
    },
  );

  panel.webview.html = renderHtml(context, panel.webview);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!bridgeCtx || !panel) return;
    if (msg?.kind !== 'db' || typeof msg.id !== 'string') return;
    try {
      const result = await handleDriverMessage(bridgeCtx, msg.payload);
      panel.webview.postMessage({ kind: 'db-reply', id: msg.id, ok: true, result });
    } catch (err) {
      panel.webview.postMessage({
        kind: 'db-reply',
        id: msg.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  panel.onDidDispose(() => {
    panel = undefined;
  });
}

/**
 * Render the webview's root HTML.
 *
 * Two transforms applied to the Vite-built `index.html`:
 *
 *   1. Asset URL rewrite — Vite emits relative paths (`./assets/...`)
 *      thanks to `base: './'`. We resolve each through
 *      `webview.asWebviewUri()` so they pass CSP and load from the
 *      locked-down vscode-webview:// origin.
 *
 *   2. CSP injection — webviews require an explicit CSP meta tag.
 *      We allow scripts from `webview.cspSource` plus a per-render
 *      nonce (Vite emits inline module-loader `<script>` tags),
 *      styles similarly, images + fonts from cspSource + data:,
 *      and `connect-src` open enough that the user's sync server
 *      is reachable (HTTP routes through the host bridge, but
 *      WebSocket / SignalR still goes direct from the webview).
 */
function renderHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const indexHtmlPath = path.join(context.extensionPath, 'media', 'webview', 'index.html');

  // Graceful fallback when the user has installed the extension
  // but hasn't built the webview bundle yet (e.g. first-time clone
  // of the source). Surfaces a clear "you need to run pnpm build"
  // page instead of a blank panel.
  if (!fs.existsSync(indexHtmlPath)) {
    return renderMissingBuildHtml(webview.cspSource);
  }

  let html = fs.readFileSync(indexHtmlPath, 'utf8');

  // Rewrite every src/href that's a relative path to its webview URI.
  // Vite emits `src="./..."` / `href="./..."` consistently given
  // base: './' in the vscode vite config; absolute paths shouldn't
  // appear, but if they did this leaves them alone.
  const mediaRoot = vscode.Uri.file(path.join(context.extensionPath, 'media', 'webview'));
  html = html.replace(/(src|href)="\.\/([^"]+)"/g, (_match, attr, rel) => {
    const onDisk = vscode.Uri.joinPath(mediaRoot, rel);
    const webUri = webview.asWebviewUri(onDisk);
    return `${attr}="${webUri.toString()}"`;
  });

  const nonce = makeNonce();
  // Inject the nonce on every <script> tag Vite emits. Vite's
  // module-loader scripts must execute inline; the nonce lets them
  // pass CSP without relaxing to 'unsafe-inline'.
  html = html.replace(/<script\b([^>]*)>/g, (_match, attrs) =>
    /\bnonce=/.test(attrs)
      ? `<script${attrs}>`
      : `<script${attrs} nonce="${nonce}">`,
  );

  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data: blob:`,
    `font-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    // 'wasm-unsafe-eval' lets the bundle's sql.js call
    // WebAssembly.instantiate() on the inlined WASM bytes. Without it,
    // the wasm step is blocked by CSP and the local DB never opens.
    //
    // 'unsafe-eval' is needed because vue-i18n compiles translation
    // message templates at runtime via `new Function(...)`. The webview
    // only loads our own bundle (no remote scripts, no user-supplied
    // code reaches the eval path), so the eval threat model that
    // motivates the CSP rule doesn't apply here. VSCode's own
    // extensions with rich UIs (Jupyter, notebook renderers, etc.)
    // take the same trade.
    `script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval' 'unsafe-eval'`,
    // SignalR WebSocket goes direct from the webview; HTTP goes
    // through the host bridge, but we still need connect-src to
    // allow the WS handshake. wss: + ws: cover both schemes.
    `connect-src ${webview.cspSource} https: http: wss: ws:`,
    `frame-src 'none'`,
  ].join('; ');

  // Replace any existing CSP meta or insert one.
  if (/<meta[^>]+http-equiv=["']?Content-Security-Policy["']?[^>]*>/i.test(html)) {
    html = html.replace(
      /<meta[^>]+http-equiv=["']?Content-Security-Policy["']?[^>]*>/i,
      `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    );
  } else {
    html = html.replace(
      /<head>/i,
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`,
    );
  }

  return html;
}

function renderMissingBuildHtml(cspSource: string): string {
  return /* html */ `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${cspSource} 'unsafe-inline';" />
    <title>Aelvory — webview not built</title>
    <style>
      body { font-family: var(--vscode-font-family); padding: 2rem; max-width: 60ch; line-height: 1.5; }
      code { background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 3px; }
      pre  { background: var(--vscode-textCodeBlock-background); padding: 0.75rem; border-radius: 4px; overflow: auto; }
    </style>
  </head>
  <body>
    <h1>Webview bundle missing</h1>
    <p>The Vue app hasn't been built into <code>media/webview/</code> yet.
       From the repo root, run:</p>
    <pre>pnpm --filter aelvory-vscode build</pre>
    <p>This compiles the desktop Vue app with the VSCode-targeted
       Vite config and emits it where the extension expects it.
       Reload the window after the build finishes
       (<code>Developer: Reload Window</code> in the command palette).</p>
  </body>
</html>`;
}

/** Cryptographically-random nonce; one per render. Used to mark
 *  Vite's inline module-loader scripts as CSP-allowed. */
function makeNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}
