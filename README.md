# Aelvory

A local-first, sync-capable API testing platform. Build collections of HTTP
and WebSocket requests on your desktop or inside VSCode, share them across
devices and teammates, and import from OpenAPI / Swagger / Postman /
Insomnia / HAR. Self-hosted; the sync server is yours.

## Rational
This project got into life because of being tired of existing, once great, products. Which started to integrate more and more and also started their business based on "user licenses".

I'm a passionate dev, i build many API's, websockets and much more. What i need is a simple testing tool of those interfaces. And i want to be able to share the config and environments with some of my friends.

In the time, where AI (e.g. claude code) is able to build such an application in almost no time. I took the time to build it together with claude. I almost did not touch any of the code.

Using it now with my friends. It allows us to do what we did before with e.g. postman or insomnia but, we control everything. From the code to the backend/sync server.

The whole project is open source. You can run it on a 4$ VPS and sync your work in your organization/team.

The cool thing, if you just want it on your local device, go ahead, build it on your own or download the latest version from releases. You don't need any account.

## Architecture


```
 ┌─────────────────────┐    ┌─────────────────────┐    ┌──────────────────┐
 │  Desktop app        │    │  VSCode extension   │    │  Marketing site  │
 │  (Tauri + Vue 3)    │    │  (Vue 3 in webview) │    │  (Caddy, static) │
 │  SQLite via         │    │  SQLite via sql.js  │    │  aelvory.com     │
 │  tauri-plugin-sql   │    │  (WebAssembly)      │    └──────────────────┘
 └──────────┬──────────┘    └──────────┬──────────┘
            │  sync                    │  sync
            └────────────┬─────────────┘
                         ▼
              ┌─────────────────────────┐
              │  Aelvory server         │
              │  (.NET 10 + Postgres)   │
              │  + SignalR realtime     │
              └─────────────┬───────────┘
                            │
                  ┌─────────┴───────────┐
                  │  Admin web SPA      │
                  │  (Vue 3, /app/)     │
                  │  members/projects/  │
                  │  per-project access │
                  └─────────────────────┘
```

The desktop app and the VSCode extension share a single Vue 3 source tree
under `apps/desktop/src/`. A runtime detector (`runtime/environment.ts`)
picks the right driver per host: Tauri's plugin-sql + plugin-http on the
desktop; sql.js (WASM) + a host postMessage bridge in the VSCode webview.
Same UI, same sync engine, same encrypted local DB — different shells.

## Repository layout

```
.
├── apps/
│   ├── desktop/            # Tauri 2 + Vue 3 desktop client (the main UI)
│   ├── server/             # ASP.NET Core 10 API (auth, sync, multi-tenancy)
│   ├── server.tests/       # xUnit + Testcontainers integration tests
│   ├── web/                # Admin SPA (Vue 3) — manage orgs / members / access
│   ├── vscode-extension/   # VSCode extension — Vue UI in a webview, sql.js DB,
│   │                       #   ws-package proxy for WebSockets, single
│   │                       #   universal .vsix (no per-platform builds)
│   └── landing/            # Marketing site for aelvory.com (Caddy, pure static)
├── packages/
│   ├── core/               # Shared TS types + parsers (curl, OpenAPI, Postman, Insomnia, HAR)
│   ├── crypto/             # E2EE primitives (Argon2id KDF, XChaCha20-Poly1305)
│   ├── i18n/               # Locale bundles shared by desktop + web (en/de/es/zh)
│   └── scripting/          # Pre/post-request script runtime
├── deploy/                 # Production-style docker-compose (server + Postgres + Caddy)
│   ├── docker-compose.yml
│   ├── .env.example
│   └── README.md           # Production-deploy reference
├── docker-compose.yml      # Dev compose — adds dotnet watch + admin SPA Vite hot reload + landing
├── package.json            # pnpm workspace root + handy scripts
├── pnpm-workspace.yaml
└── Aelvory.sln             # Visual Studio solution (server + tests)
```

## Tech at a glance

| Layer | Stack |
|---|---|
| Desktop client | Vue 3, Pinia, PrimeVue, Vue Router, Tauri 2, vue-i18n, tauri-plugin-{sql,http,dialog,fs} |
| Local storage (desktop) | SQLite via tauri-plugin-sql (per-user, persists across restarts) |
| VSCode extension | Same Vue tree as the desktop, esbuild-bundled host code, sql.js (WASM) for SQLite, Node `ws` package for the WebSocket proxy |
| Local storage (VSCode) | sql.js (WebAssembly SQLite) — host owns the on-disk file, the webview owns the engine |
| Server | ASP.NET Core 10, EF Core 10 + Npgsql, SignalR, NSwag (OpenAPI), JWT bearer auth |
| DB | Postgres 16 |
| Realtime | SignalR `/hubs/sync` (WebSocket) |
| Crypto | Argon2id (password hash + KDF) · XChaCha20-Poly1305 (E2EE payload) · SHA-256 (refresh-token storage) · HMAC-SHA256 (JWT) |
| Admin SPA | Vue 3, PrimeVue, Pinia, Vue Router, Caddy (prod static + reverse proxy) |
| Marketing site | Pure static HTML/CSS, served by Caddy (`apps/landing/`) |
| Build | `pnpm` workspaces (frontend) · `dotnet` (backend) · `esbuild` + `vsce` (VSCode extension) |

## Prerequisites

| Tool | Version | Used for |
|---|---|---|
| **Node.js** | 22.x | desktop / web / packages |
| **pnpm** | 9.12.0 (pinned via `packageManager`) | workspace install + scripts |
| **.NET SDK** | 10.x | server build / `dotnet ef` migrations |
| **Docker** | recent | bundled Postgres + Redis + MinIO + (optionally) the server itself |
| **Rust toolchain** | stable | `tauri build` only — `tauri dev` works on prebuilt webview |

On Windows, Docker Desktop with WSL2 backend is the smoothest path. On macOS,
Docker Desktop or OrbStack. On Linux, native docker engine.

## Getting started — the 60-second loop

```bash
# 1. install workspace deps (root + apps/* + packages/*)
pnpm install

# 2. bring up Postgres / Redis / MinIO + the .NET server in dev mode
#    (server runs `dotnet watch run` inside the container, reloads on change)
docker compose up -d

# 3. run the desktop app
pnpm dev
```

That's it. The desktop opens, signs you in as a fresh local user (no server
account needed for offline use), and you can start clicking around.

To enable cross-device sync, open Settings → Sync, point Server URL at
`http://127.0.0.1:5000`, sign up, and the desktop will start syncing.

## Running the pieces individually

Each layer can run on its own — useful when you're iterating on just one.

### Just the infra (Postgres + Redis + MinIO)

```bash
pnpm infra:up        # → docker compose up -d postgres redis minio
```

Use this when you want to run the .NET server directly from `dotnet run` (faster
inner loop than container rebuilds):

```bash
cd apps/server
DOTNET_ROLL_FORWARD=Major dotnet run
# server up at http://localhost:5000
```

### Server in container

```bash
docker compose up -d server
docker compose logs -f server
# wait for "Now listening on: http://[::]:5000"
```

The compose file mounts the source as a bind mount and runs `dotnet watch run`,
so edits to `.cs` files trigger an automatic rebuild + restart inside the
container.

### Desktop client

```bash
pnpm dev                                   # = pnpm --filter @aelvory/desktop tauri dev
# OR explicitly:
pnpm --filter @aelvory/desktop tauri dev
```

The desktop window opens with Vite dev server hot-reload backing it. Edit any
`apps/desktop/src/**/*.vue` or `.ts` file — changes hot-replace without
restarting the window.

### Admin SPA

```bash
pnpm dev:web                               # = pnpm --filter @aelvory/web dev
```

Vite serves on `http://localhost:5174/app/` and proxies `/api/*` + `/hubs/*` to
`http://localhost:5000` (the .NET server). Same-origin, no CORS in dev.

The admin SPA is also built into a static bundle and served by Caddy in
production — see `deploy/README.md` for that path.

### VSCode extension

The extension lives in `apps/vscode-extension/`. It's a single
platform-agnostic `.vsix` — same file works on every OS / arch / VSCode
version because the SQLite engine is sql.js (WebAssembly) and the
extension host is esbuild-bundled.

```bash
# One-shot — build webview + host bundle + .vsix
pnpm --filter aelvory-vscode package
# → apps/vscode-extension/aelvory-vscode-0.0.1.vsix  (~1.2 MB)

# Install locally
code --install-extension apps/vscode-extension/aelvory-vscode-0.0.1.vsix --force
```

Other useful invocations:

| Command | Purpose |
|---|---|
| `pnpm --filter aelvory-vscode build` | Webview + host bundle, no `.vsix` |
| `pnpm --filter aelvory-vscode build:webview` | Just the Vite VSCode-target build |
| `pnpm --filter aelvory-vscode build:extension` | Just the esbuild host bundle |
| `pnpm --filter aelvory-vscode watch` | esbuild watch mode (for F5 dev) |
| `pnpm --filter aelvory-vscode typecheck` | `tsc --noEmit` for the host |

For F5 development, open `apps/vscode-extension/` as a VSCode workspace
and press F5 — that launches an Extension Development Host with the
unpackaged extension loaded straight from `out/`. Run `pnpm build` once
first so `out/extension.js` and `media/webview/` exist; after that
`pnpm watch` keeps the host bundle hot. Webview changes need a manual
`pnpm --filter @aelvory/desktop build:vscode` (Vite isn't in watch
mode for the VSCode target).

Full publish / distribute notes live in
[`apps/vscode-extension/README.md`](apps/vscode-extension/README.md).

### Marketing landing site

`apps/landing/` is a pure-static Caddy-served site for aelvory.com.
No build step.

```bash
docker compose up -d landing
# → http://localhost:8080
```

For deployment notes (Cloudflare Tunnel, direct exposure with managed
cert), see [`apps/landing/README.md`](apps/landing/README.md).

### Server tests

```bash
dotnet test apps/server.tests/Aelvory.Server.Tests.csproj
```

Spins up a real Postgres in Docker via Testcontainers (image `postgres:16-alpine`,
matching the dev compose). Covers auth, multi-tenancy, sync, tombstone
propagation, security hardening (JWT key fail-fast, rate limiting,
hashed refresh tokens), and admin CRUD — runs in ~2 min.

Docker has to be running for Testcontainers. First execution pulls the postgres
image (~10 s); subsequent runs reuse the image (~5 s container start).

## Available scripts (root `package.json`)

| Script | Purpose |
|---|---|
| `pnpm dev` | Desktop app via `tauri dev` |
| `pnpm dev:web` | Admin SPA via Vite |
| `pnpm tauri <subcommand>` | Pass-through to `tauri` CLI in the desktop workspace |
| `pnpm build` | Build every workspace package (`pnpm -r build`) |
| `pnpm infra:up` | Bring up Postgres + Redis + MinIO only |
| `pnpm infra:down` | Stop the infra (volumes survive) |
| `pnpm docker:up` / `docker:up:detached` | Full dev compose (foreground / background) |
| `pnpm docker:down` | Stop the full dev compose |
| `pnpm docker:logs` | Follow logs across all services |
| `pnpm docker:rebuild` | Force rebuild + recreate `server` and `web` containers |
| `pnpm gen-client` | Run NSwag against the running API to regenerate the typed TS client |
| `pnpm migration:add <Name>` | EF migration scaffold (host-side `dotnet ef`) |
| `pnpm migration:apply` | Apply migrations to the Postgres in `infra:up` |
| `pnpm docker:gen-client` / `docker:migration:apply` | Same, but via the `tools` compose service (no host `dotnet ef` needed) |

## Building production images

The desktop ships as a Tauri-built native binary; the VSCode extension
ships as a single `.vsix` (see the section above); the server, admin
SPA, and marketing site ship as Docker images.

### Desktop

```bash
pnpm --filter @aelvory/desktop tauri build
```

Output:
- Windows: `apps/desktop/src-tauri/target/release/bundle/{msi,nsis}/`
- macOS: `apps/desktop/src-tauri/target/release/bundle/{dmg,macos}/`
- Linux: `apps/desktop/src-tauri/target/release/bundle/{deb,appimage}/`

Code-signing isn't wired up — you'll need to add platform-specific signing if
you distribute publicly.

### Server image

```bash
docker build -f apps/server/Dockerfile -t aismart/aelvory-server:latest .
docker push aismart/aelvory-server:latest
```

Build context is the repo root because the multi-stage build needs the workspace
metadata. Resulting image is `mcr.microsoft.com/dotnet/aspnet:10.0` based,
listening on `:8080`, with curl pre-installed for the `/healthz` HEALTHCHECK.

### Web admin image

```bash
# Note: pnpm workspace symlinks confuse Docker BuildKit on Windows.
# If the build aborts with "file cannot be accessed by the system",
# delete the offending node_modules dirs and re-run:
rm -rf apps/web/node_modules apps/desktop/node_modules
docker build -f apps/web/Dockerfile -t aismart/aelvory-web:latest .
docker push aismart/aelvory-web:latest
# After the build, restore host deps:
pnpm install
```

Multi-stage: `node:22-alpine` builds the static bundle (`vite build`),
`caddy:2-alpine` serves it. Caddy reverse-proxies `/api/*` + `/hubs/*` to the
`aelvory-server` container on the compose internal network.

### Marketing site (landing) image

```bash
# Multi-arch (amd64 + arm64), pushed in one shot:
docker buildx build --platform linux/amd64,linux/arm64 \
  -t aismart/aelvory-landing:latest \
  -t aismart/aelvory-landing:0.0.1 \
  --push apps/landing
```

Single-stage: `caddy:2-alpine` serves `apps/landing/public/` verbatim. No
build step, no Node, no JS framework. The published image works behind
Cloudflare on plain HTTP, or set `AELVORY_LANDING_DOMAIN=aelvory.com` to
have Caddy manage its own Let's Encrypt cert directly. Full deploy notes
in [`apps/landing/README.md`](apps/landing/README.md).

## Production deployment

The end-to-end production stack lives in `deploy/`. Postgres + the API server
(private to compose network) + Caddy (the only public surface) — see
[`deploy/README.md`](deploy/README.md) for the full runbook including Let's
Encrypt, image-tag pinning, and persistence layout.

Quick version:

```bash
cd deploy
cp .env.example .env

# Generate a real signing key (≥ 32 bytes):
openssl rand -base64 48
# or PowerShell:
# [Convert]::ToBase64String((1..48 | %{[byte](Get-Random -Max 256)}))

# Edit .env — set JWT_SIGNING_KEY and POSTGRES_PASSWORD.

# First boot — apply migrations:
RUN_MIGRATIONS=true docker compose up -d

# Subsequent restarts:
docker compose up -d
```

Once everything reports healthy, the admin SPA is at
`http://localhost/app/`, the API is reverse-proxied at `http://localhost/api/*`,
and the desktop client points at `http://localhost` (or the public domain you
set in `AELVORY_DOMAIN`).

The server **fails to start** in non-Development environments if `JWT_SIGNING_KEY`
is the in-repo dev sentinel or shorter than 32 bytes. Don't ignore that;
forging admin tokens with the dev key is trivial.

## Environment variables (server)

Production reads these via `appsettings.Production.json` overrides or env vars.
The Docker compose maps each to the standard ASP.NET Core `__`-separated form
(e.g. `Jwt__SigningKey`).

| Var | Default | Notes |
|---|---|---|
| `ASPNETCORE_ENVIRONMENT` | `Production` | `Development` exposes Swagger UI without auth + auto-runs migrations |
| `ConnectionStrings__Postgres` | (no default in prod) | `Host=postgres;Port=5432;Database=aelvory;Username=aelvory;Password=...` |
| `Jwt__SigningKey` | — required — | ≥32 bytes; non-Dev startup refuses the dev sentinel |
| `Jwt__Issuer` | `aelvory` | Match on any clients that validate |
| `Jwt__Audience` | `aelvory-clients` | Same |
| `Jwt__AccessTokenMinutes` | `15` | Short lived; refresh tokens cover continuity |
| `Jwt__RefreshTokenDays` | `30` | Stored as SHA-256 hash; rotated on use |
| `RUN_MIGRATIONS` | `false` (in prod compose) | Set `true` for first boot or controlled migration windows |

## Multi-tenant model

The data hierarchy is **Organization → Project → Collection → Request**.
Members exist at the org level with one of three roles:

| Role | Sees | Can manage |
|---|---|---|
| Owner | everything in the org | invite/remove/change roles, delete the org |
| Admin | everything | invite/remove/change roles |
| Editor | everything (default) or only granted projects (`Restricted`) | nothing org-level |

Restricted Editors only see projects they have an explicit `ProjectMember`
grant for. The server enforces this on `/api/sync/pull` and rejects pushes to
non-granted projects.

## Sync model

Two kinds of data live on the server:

1. **Entity tables** (`Organizations`, `Projects`, `Members`, `ProjectMembers`)
   — what the admin SPA reads and writes. Reflected into `SyncEntries` via
   `ISyncEntityBridge` so desktops also receive admin-UI changes via the sync log.

2. **`SyncEntries`** — append-only opaque payload log, scoped per organization
   with a monotonically increasing `Seq`. The desktop pushes here and pulls
   from here. Realtime: SignalR `/hubs/sync` fires `Changed(orgId, cursor)`
   whenever a push lands, so other connected clients pull immediately.

Last-writer-wins by `UpdatedAt`; older pushes are reported back as conflicts
on the response so the client can re-pull.

## End-to-end encryption (E2EE)

Optional per-org. When enabled in the desktop app's Settings:
- Passphrase + email salt → Argon2id → 32-byte key (passphrase never leaves
  the device; salt-from-email is acknowledged as weaker than per-user random
  salt — see `apps/desktop/src/services/syncCrypto.ts` comment for the
  trade-off).
- Sync payloads are encrypted with XChaCha20-Poly1305 (random 24-byte nonce
  per entry, AEAD).
- Server stores ciphertext only; can't read content but still scopes pull
  responses by membership.

Conflict resolution is degraded under E2EE because the server can't inspect
encrypted rows. If you sync across many devices regularly, leave E2EE off; if
your sync server is untrusted, turn it on and accept the occasional duplicate.

## Known issues / non-goals

These are documented gaps, not bugs:

- **`isSecret` on variables** is currently a UI-masking flag, not encryption-
  at-rest, when E2EE is off. Don't store production credentials in variables
  expecting them to be encrypted on the server.
- **Pre/post request scripts** run in the main webview with full access. Today
  this is single-user-only. Sharing collections that contain scripts is gated
  on a sandbox (Web Worker / QuickJS-WASM) — not yet shipped.
- **No invite emails** — invites today require the invitee to already have an
  Aelvory account (admin SPA → Members → Invite by email). Email-based invite
  links are Phase 4.
- **Single Tauri window per user** — multi-window isn't supported.
- **VSCode sidebar tree of collections** — the activity-bar icon shows
  workspace status + quick actions, but a native VSCode TreeView mirroring
  the in-webview collection tree is not yet wired up.

## Where to go for more detail

- `deploy/README.md` — production deployment + runbook
- `apps/web/README.md` — admin SPA architecture + file map
- `apps/vscode-extension/README.md` — VSCode extension build + bridge
  protocol + storage scope settings
- `apps/landing/README.md` — landing site deploy notes
  (Cloudflare Tunnel + direct exposure)
- Source comments — every non-obvious decision has a paragraph explaining
  *why*. `Program.cs`, `SyncEntityBridge.cs`, `syncEngine.ts`,
  `syncCrypto.ts`, the VSCode bridge in
  `apps/vscode-extension/src/bridge.ts`, and the migration files are good
  starting points.
- The integration tests in `apps/server.tests/` are also documentation:
  they pin the security and multi-tenant invariants in concrete English.
