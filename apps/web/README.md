# @aelvory/web

Admin SPA for managing Aelvory organizations, members, projects, and
per-project access. The Aelvory desktop app is where you build
collections and run requests; this web app is where you decide *who
can see what*.

## Dev loop

```bash
pnpm install                       # one-time
pnpm --filter @aelvory/web dev
```

Vite serves on `http://localhost:5174/app/` and proxies `/api/*` and
`/hubs/*` to `http://localhost:5000` (the .NET server). Same-origin —
no CORS to think about.

The .NET API needs to be running. Either:

```bash
# Option A — run the server with the bundled compose:
cd deploy
RUN_MIGRATIONS=true docker compose up -d

# Option B — run the API directly from source for tighter loops:
cd apps/server
DOTNET_ROLL_FORWARD=Major dotnet run
```

## What's here today

- Sign in / sign up
- Org switcher (sidebar)
- Members: list / invite / role + restricted toggle / remove
- Projects: list / create / edit / delete
- Per-project access: list grants / add / revoke

## What's not here yet (intentional)

- **Email-based invitation links** — the invite flow today requires the
  invitee to already have an Aelvory account. The server invite token
  + email-out story is Phase 4.
- **E2EE wrapped DEK on invite** — invites send `wrappedDek: ""`. Real
  E2EE distribution lands when shared-org E2EE is implemented.
- **Activity feed / audit log** — the server already logs actions via
  `IActivityLogger`; surfacing it as a page is a nice-to-have.
- **Real-time updates** — the page reloads its data on mount. Pulling
  via SignalR works but isn't wired into this UI yet.

## Production deploy

The Caddyfile in `deploy/` serves the built static bundle at `/app/`
and reverse-proxies `/api/` and `/hubs/` to the API container:

```bash
pnpm --filter @aelvory/web build              # → apps/web/dist
rsync -a apps/web/dist/ deploy/web-dist/
docker compose -f deploy/docker-compose.yml up -d
```

(Compose service for Caddy + the volume mount is described in
`deploy/README.md`.)

## File map

```
src/
  main.ts                 # boot
  App.vue                 # ConfirmDialog + Toast + RouterView
  router/index.ts         # / + /signin + /signup + auth guard
  i18n/index.ts           # vue-i18n, shared with desktop via @aelvory/i18n
  services/
    api.ts                # fetch wrapper + bearer token + auto-refresh
  stores/
    auth.ts               # signin/signup, JWT decode, persisted tokens
    orgs.ts               # org list + currentOrgId
  layouts/
    AdminLayout.vue       # sidebar (org switcher + nav) + content slot
  views/
    SignIn.vue
    SignUp.vue
    Home.vue              # / — redirects into the org's members page
    OrgMembers.vue        # /orgs/:orgId/members
    OrgProjects.vue       # /orgs/:orgId/projects
    ProjectMembers.vue    # /orgs/:orgId/projects/:projectId/members
```
