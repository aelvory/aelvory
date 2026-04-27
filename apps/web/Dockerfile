# Production build for the Aelvory admin SPA.
#
# Stage 1 — Node + pnpm builds the static bundle (Vite output).
# Stage 2 — Caddy serves the bundle and reverse-proxies /api + /hubs
#           to the aelvory-server container on the same compose network.
#
# Build context must be the repo root (the workspace package
# dependencies cross app boundaries):
#   docker build -f apps/web/Dockerfile -t aismart/aelvory-web .

FROM node:22-alpine AS build
WORKDIR /repo

# Enable pnpm via corepack so the lockfile is honored exactly.
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Copy manifests first so Docker layer-caches the install step.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/i18n/package.json packages/i18n/
COPY packages/core/package.json packages/core/

# Phase 1 install — only the web app's dependency closure. Skips
# better-sqlite3 (the vscode-extension's optional native dep) since we
# don't include that workspace at all.
RUN pnpm --filter "@aelvory/web..." install --frozen-lockfile

# Now bring in the source for the workspaces we need.
COPY apps/web/ apps/web/
COPY packages/i18n/ packages/i18n/
COPY packages/core/ packages/core/

# Build — vue-tsc + vite. Output: apps/web/dist/
RUN pnpm --filter @aelvory/web build

# ---- Runtime ----
FROM caddy:2-alpine
# Default site address. Caddy's `{$VAR:default}` Caddyfile syntax only
# falls back to the default when the env var is UNSET — not when it's
# empty. Setting a non-empty default at the image layer means the
# Caddyfile always parses cleanly, even if a downstream compose passes
# `AELVORY_DOMAIN=""` (a footgun in plain shell-style interpolation).
# Override with a real domain to enable automatic HTTPS via Let's
# Encrypt: `-e AELVORY_DOMAIN=eu.aelvory.com`.
ENV AELVORY_DOMAIN=:80
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv/spa
EXPOSE 80 443

# Caddy's image already sets a sensible CMD; leave it alone so our
# Caddyfile is auto-loaded from /etc/caddy/Caddyfile.
