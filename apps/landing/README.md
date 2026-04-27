# aelvory-landing

Marketing site for [aelvory.com](https://aelvory.com). Pure static —
HTML, CSS, an SVG logo, a favicon. No build step, no JS framework, no
dependencies.

## What's in here

```
apps/landing/
├── public/
│   ├── index.html        — single-page site, semantic markup
│   ├── style.css         — CSS custom properties + system fonts,
│   │                       prefers-color-scheme dark mode
│   └── assets/
│       └── logo.svg      — triangular A glyph (uses currentColor
│                           so it inherits text color)
├── public/favicon.png    — copied from the desktop app
├── Caddyfile             — production server config
├── Dockerfile            — caddy:2-alpine image
└── README.md             — this file
```

## Run locally

The simplest path is the docker-compose service:

```bash
# From the repo root
docker compose up -d landing
# → http://localhost:8080
```

Or build the image directly:

```bash
docker build -t aismart/aelvory-landing apps/landing
docker run --rm -p 8080:80 aismart/aelvory-landing
```

For pure static editing without Docker, point any static server at
`apps/landing/public/`:

```bash
cd apps/landing/public
python3 -m http.server 8080      # or `npx serve`, etc.
```

## Deploy

The site lives behind Cloudflare. Two deployment shapes work:

### A. Cloudflare Tunnel (recommended)

Run the container on any host, terminate at Cloudflare. The origin
stays HTTP-only — Cloudflare does the TLS work.

```bash
# On the deploy host
docker compose up -d landing
# Then point a Cloudflare Tunnel at http://localhost:8080
# and add a public hostname rule: aelvory.com → that origin.
```

No env vars needed — the default `AELVORY_LANDING_DOMAIN=:80` listens
on plain HTTP on port 80 inside the container.

### B. Direct exposure with managed cert

Bind the container's port 80 + 443 to the host and let Caddy fetch a
Let's Encrypt cert. DNS for `aelvory.com` must point at this host.

```yaml
# In docker-compose.yml landing service
environment:
  AELVORY_LANDING_DOMAIN: aelvory.com
ports:
  - "80:80"
  - "443:443"
volumes:
  - landing_caddy_data:/data
  - landing_caddy_config:/config
```

The volumes persist the cert across container restarts so Caddy
doesn't re-issue every time you redeploy (Let's Encrypt rate limits
will bite you otherwise).

## Editing content

Open [public/index.html](public/index.html) and edit. The structure:

| Section | Element | Purpose |
|---|---|---|
| Top bar | `.topbar` | Sticky brand + nav |
| Hero | `.hero` | Headline, lede, CTAs |
| Features | `#features` | 6-card grid: HTTP, WS, sync, etc. |
| Platforms | `#platforms` | Desktop / VSCode / Sync server |
| Self-host | `#self-host` | Open-source CTAs |
| Footer | `.footer` | Brand + GitHub links + credit line |

Styles live in [public/style.css](public/style.css). Color tokens
are CSS custom properties at `:root`, with a single
`prefers-color-scheme: dark` override block — no theme toggle, the
visitor's OS preference is the source of truth.

## What's intentionally *not* here

- No analytics. (If you need them, drop a Cloudflare Web Analytics
  beacon — privacy-respecting, no JS bundle.)
- No web fonts. System fonts only — instant first paint and zero
  third-party network surface.
- No JS framework. The site is brochure-static. If we need a
  contact form or an interactive demo later, drop in a `<script>`
  tag with vanilla JS or wire up Vite — both are easy from here.
- No CMS. Edit the HTML; commit; redeploy.
