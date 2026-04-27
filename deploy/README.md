# deploy

Production-style compose for running Aelvory end-to-end: API server,
Postgres, and the admin SPA fronted by Caddy.

## What's running

| Service          | Image                              | Public? |
|------------------|------------------------------------|---------|
| `aelvory-web`    | `aismart/aelvory-web:latest`       | Yes — only public-facing service. Caddy serves `/app/` and reverse-proxies `/api/*` + `/hubs/*` to the API container on the internal network. |
| `aelvory-server` | `aismart/aelvory-server:latest`    | No — internal compose network only. Reachable via the web container. |
| `postgres`       | `postgres:16-alpine`               | No — internal only. |

## Quick start

```bash
cd deploy
cp .env.example .env

# Generate a real JWT signing key (≥ 32 bytes):
openssl rand -base64 48

# Edit .env — set JWT_SIGNING_KEY and POSTGRES_PASSWORD.

# First boot against a fresh DB — apply schema migrations:
RUN_MIGRATIONS=true docker compose up -d

# Subsequent restarts:
docker compose up -d
```

Once everything reports healthy in `docker compose ps`, browse to:

- **`http://localhost/app/`** — admin SPA (sign up here on first run)
- **`http://localhost/api/...`** — API (same origin, no CORS)
- `http://localhost/` redirects to `/app/` until a marketing site
  lives there

## Pointing the desktop client at this server

Open Settings → Sync → Server URL and set:

```
http://localhost
```

(or whatever public URL you've put in `AELVORY_DOMAIN`). The desktop
hits `/api/*` + `/hubs/*` underneath that, which Caddy routes to the
API container.

## Public domain + HTTPS

Set `AELVORY_DOMAIN=your.host.example.com` in `.env`, point DNS at the
host, and on first boot Caddy fetches a Let's Encrypt cert
automatically. Ports 80 and 443 must be reachable from the public
internet for the ACME HTTP-01 challenge.

## Image tags

Both images default to `:latest`. For repeatable deploys, pin SHA tags
in `.env`:

```env
AELVORY_SERVER_TAG=9ad00e9
AELVORY_WEB_TAG=abc1234
```

Upgrade:

```bash
docker compose pull
docker compose up -d
```

## Persistence

| Volume         | Holds                                                  | Lost on |
|----------------|--------------------------------------------------------|---------|
| `pg_data`      | Postgres data files                                    | `down -v` |
| `caddy_data`   | Auto-fetched ACME certs, account keys                  | `down -v` |
| `caddy_config` | Caddy's config snapshot (rarely interesting)           | `down -v` |

Survive plain `docker compose down`, lost on `down -v`. Back the
volumes up before that if you care.

## Schema bootstrap

EF Core migrations run on the API container only when
`RUN_MIGRATIONS=true` (or in Development environment). The first boot
needs them; rolling restarts shouldn't apply schema by surprise.

```bash
# First boot:
RUN_MIGRATIONS=true docker compose up -d

# After a release that adds a migration:
RUN_MIGRATIONS=true docker compose up -d --no-deps aelvory-server
# wait for the log line "Migrations applied.", then:
docker compose up -d
```

Failure crashes the server container; `restart: unless-stopped` brings
it back. Transient issues self-heal, genuinely-bad migrations are loud
(the container keeps restarting and log-spamming).

## Security checklist before exposing publicly

- [ ] `JWT_SIGNING_KEY` is real randomness, not the example value
- [ ] `POSTGRES_PASSWORD` is real, not the example value
- [ ] `ASPNETCORE_ENVIRONMENT=Production` (Development exposes the
      Swagger UI without auth)
- [ ] `AELVORY_DOMAIN` is set so Caddy serves HTTPS, not bare HTTP
- [ ] Postgres is **not** port-mapped to the host (it isn't by
      default; double-check if you uncommented the mapping)
- [ ] The API container has **no host port mapping** either — Caddy
      is the only public surface (default behaviour)
- [ ] CORS in `Program.cs` matches the origins you actually use.
      Same-origin via Caddy means CORS is rarely involved at all
