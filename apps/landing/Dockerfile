# Production image for the Aelvory marketing site.
#
# Pure static — no Node, no build step. The site is plain HTML + CSS
# + an SVG, served by Caddy. Build context is this directory; no
# repo-root context required:
#
#   docker build -t aismart/aelvory-landing apps/landing
#
# Or via docker-compose: `docker compose build landing`.

FROM caddy:2-alpine
# Default site address. Caddy's `{$VAR:default}` Caddyfile syntax
# only falls back to the default when the env var is UNSET — not
# when it's empty. Setting a non-empty default at the image layer
# means the Caddyfile always parses cleanly, even if a downstream
# compose passes `AELVORY_LANDING_DOMAIN=""`.
ENV AELVORY_LANDING_DOMAIN=:80
COPY Caddyfile /etc/caddy/Caddyfile
COPY public/ /srv/site/
EXPOSE 80 443

# Caddy's image already sets a sensible CMD; leave it alone so our
# Caddyfile is auto-loaded from /etc/caddy/Caddyfile.
