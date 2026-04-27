# aelvory-vscode

The Aelvory desktop app, embedded in a VSCode webview. Same Vue UI, same
sync engine, same local SQLite database — just hosted by VSCode instead of
Tauri.

## What's in the box

- `src/extension.ts` — activation, the `Aelvory: Open` / `Aelvory: Sync now`
  / `Open in Aelvory` commands, sidebar welcome view, webview panel,
  CSP + nonce + asset-URL rewriting.
- `src/bridge.ts` — three op families crossing `postMessage`:
  - **DB file I/O** (`db.read`, `db.write`) — host owns the bytes on disk;
    the SQLite engine itself runs in the webview as sql.js (WebAssembly).
  - **HTTP** (`http.fetch`) — Node fetch in the host, no CORS.
  - **Files** (`fs.saveAs`) — `vscode.window.showSaveDialog` + `fs.writeFile`.
- The matching webview shims live in `apps/desktop/src/`:
  - `localdb/driver.sqljs.ts` — DbDriver implementation backed by sql.js,
    with a debounced flush that pushes serialised bytes back to the host.
  - `services/vscodeBridge.ts` — HTTP, saveAs, db.read, db.write.
  - `runtime/environment.ts` — runtime detection picks the right branches
    when `acquireVsCodeApi` is available.

## Build

```bash
# From repo root
pnpm install
pnpm --filter aelvory-vscode build
```

That runs two steps:

1. **Webview** — `pnpm --filter @aelvory/desktop build:vscode` invokes Vite
   with `apps/desktop/vite.config.vscode.ts`, emitting the Vue app to
   `apps/vscode-extension/media/webview/`. `base: './'` keeps asset URLs
   relative so the extension can rewrite them through `webview.asWebviewUri`.
   The Vite config also inlines sql.js's `sql-wasm.wasm` into the bundle as
   a base64 string (see `__SQL_JS_WASM_BASE64__`), so there's no separate
   asset to ship and no CSP fetch rules to navigate.
2. **Extension host** — `node esbuild.mjs` bundles `src/extension.ts` into a
   single `out/extension.js` (~13 KB; the host code is just file-I/O proxy
   + webview wiring). Marking only `vscode` external sidesteps pnpm's
   symlinked layout that `vsce` can't traverse correctly.
   `pnpm typecheck` runs `tsc --noEmit` separately if you want type
   diagnostics.

## Run / debug

Open `apps/vscode-extension/` as a VSCode workspace and press **F5** to
launch an Extension Development Host. In the new window:

- Click the **Aelvory icon in the activity bar** (the triangular A on the
  left rail) → use the welcome view's "Open Aelvory" button.
- `Ctrl+Shift+P` → `Aelvory: Open` → opens the webview tab
- `Ctrl+Shift+P` → `Aelvory: Sync now` → triggers a sync (after sign-in)
- **Right-click any `.har` / `.yaml` / `.yml` / `.json` in the explorer**
  → `Open in Aelvory` → reads the file, picks the right import tab
  based on extension and a content peek, opens the dialog pre-filled.
  The same option also appears on the editor tab's right-click menu.

## Storage scope

`aelvory.storageScope` setting (Settings → Extensions → Aelvory):

| Value | DB location | Use when |
|---|---|---|
| `global` *(default)* | `globalStorageUri/aelvory.db` (cross-window) | API testing follows the user — same collections regardless of which project you're in |
| `workspace` | `storageUri/aelvory.db` (per workspace folder) | Different projects keep separate request collections; switching VSCode windows switches collections |

Workspace mode falls back to global with a one-time toast when no
folder is open. Changing the setting prompts for a window reload —
the dbPath is captured at activation time, so a hot-swap would
silently leave the UI showing rows from the previous DB.

The first open call:
- Creates `aelvory.db` under your VSCode global-storage path
  (`~/.config/Code/User/globalStorage/aelvory.aelvory-vscode/aelvory.db` on
  Linux, equivalent paths on macOS/Windows)
- Runs migrations (in-webview, against sql.js)
- Loads the Vue UI

If the webview shows "Webview bundle missing" you need to run the build
above and reload the window (`Developer: Reload Window`).

## Package + install

The packaging tool is `vsce` (the official Visual Studio Code Extension
Manager CLI). Install it once globally — `vsce` isn't a workspace dep
because it's a developer tool, not a runtime one:

```bash
npm install -g @vscode/vsce
```

Then from the repo root:

```bash
pnpm --filter aelvory-vscode package
```

That runs `pnpm build` (webview + host) and then `vsce package
--no-dependencies`. The output is `aelvory-vscode-<version>.vsix` in
`apps/vscode-extension/` — about 1.2 MB total.

The package is **platform-agnostic**: one `.vsix` works on every OS and
CPU architecture VSCode supports, because the SQLite engine is
WebAssembly. No per-target `.vsix`, no NODE_MODULE_VERSION matrix,
no rebuild on Electron upgrades.

### Install for personal use (CLI)

```bash
code --install-extension apps/vscode-extension/aelvory-vscode-0.0.1.vsix
```

If `code` isn't on your PATH: in VSCode → `Ctrl+Shift+P` →
`Shell Command: Install 'code' command in PATH`, then retry.

### Install for personal use (UI)

`Ctrl+Shift+P` → `Extensions: Install from VSIX…` → pick the file.

### Distribute internally

Drop the `.vsix` on a shared drive / internal server / GitHub release.
Anyone with a copy of the file can `code --install-extension <path>`.
Updates: bump `version` in `package.json`, repackage, redistribute.
VSCode shows the new version under "Outdated extensions" if its
`version` field is higher than the installed one.

### Distribute on the marketplace

```bash
vsce login aelvory   # uses a Personal Access Token
vsce publish         # from apps/vscode-extension/
```

Requires creating a publisher in the
[VSCode marketplace](https://marketplace.visualstudio.com/manage), and
the `publisher` field in `package.json` matching that publisher id.
Marketplace-published versions get auto-updates from VSCode.

## Architecture: how two runtimes share one Vue app

```
                  ┌─────────────────────────────────────────────┐
                  │               apps/desktop/src/             │
                  │   (Vue 3 + Pinia + PrimeVue — single tree)  │
                  └──────────┬─────────────┬────────────────────┘
                             │             │
              runtime/environment.ts picks one branch:
                             │             │
            isTauriEnv()  ◄──┘             └──►  isVSCodeEnv()
                  │                                  │
        ┌─────────▼─────────┐               ┌────────▼─────────┐
        │  Tauri 2 (Rust)   │               │  Webview         │
        │  plugin-sql       │               │  sql.js (WASM)   │
        │  plugin-http      │               │   ↓ db.read/     │
        │  plugin-dialog/fs │               │     db.write     │
        └───────────────────┘               │  Host            │
                                            │  fs.read/write   │
                                            │  Node fetch      │
                                            │  showSaveDialog  │
                                            └──────────────────┘
```

Each platform-specific dependency is loaded via `await import(...)` only on
its branch, so the VSCode bundle doesn't include `@tauri-apps/*` and the
Tauri bundle doesn't include the VSCode bridge.

### Why sql.js instead of better-sqlite3

The earlier prototype ran better-sqlite3 in the extension host. Each
better-sqlite3 prebuilt binary is tagged with a `NODE_MODULE_VERSION`
matching the Electron build it was compiled against — and VSCode
upgrades Electron every few months. The breakage chain we hit:

- Wrong arch: clobbered host binary from a per-target packaging run.
- Wrong runtime: `--target node` instead of `--target electron` — they
  use different NMV tables.
- Wrong NMV: prebuild-install's electron-version → NMV map disagreed
  with the user's installed VSCode.
- Wrong package version: better-sqlite3 v11 hadn't published prebuilds
  for the Electron release VSCode was actually on.

Each step required a rebuild + reinstall, and any future Electron bump
restarts the cycle. sql.js sidesteps the whole class of failure: WASM
runs anywhere, no compile, no version table to maintain.

The cost is roughly 3× slower bulk inserts, which is invisible at
Aelvory's scale (hundreds of rows per project, sub-second sync
transactions either way).

## Bridge wire protocol (for reference)

Webview → host (`postMessage`):

```ts
{ kind: 'db', id: '<correlation>', payload: <op> }
```

Where `<op>` is one of:

```ts
{ op: 'db.read' }
{ op: 'db.write', bytes: '<base64>' }
{ op: 'http.fetch', url, init: { method?, headers?, body?, timeoutMs? } }
{ op: 'fs.saveAs', defaultName, content, filters? }
```

Host → webview:

```ts
{ kind: 'db-reply', id: '<correlation>', ok: true,  result: <op-specific> }
{ kind: 'db-reply', id: '<correlation>', ok: false, error: '<message>' }
```

Host → webview commands (no reply expected):

```ts
{ kind: 'cmd', cmd: 'sync.now' }
{ kind: 'cmd', cmd: 'import', format, content, filename }
```

## What's intentionally not here yet

- **Sidebar tree of collections + requests.** The activity-bar icon is in
  place (a welcome view with "Open Aelvory" / "Sync now" links), but the
  actual tree of collections and requests still lives only inside the
  webview's `CollectionTree.vue`. Mirroring it as a real VSCode TreeView
  would feel more native but duplicate the data binding. Worth doing once
  the webview UX is stable.

## Schema parity

`apps/desktop/src/localdb/migrations.ts` is the single source of schema
truth. Both the Tauri build and the VSCode build run the same migration
list against their respective drivers — Tauri-plugin-sql for the desktop
app, sql.js for the webview. Adding a new migration is one append to
`ALL_MIGRATIONS`, no twin definitions to keep in sync.
