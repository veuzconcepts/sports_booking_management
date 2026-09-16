# Customer Website (`web/`)

Public marketing and booking site, built with **Astro** (SSR via the Node
adapter) with React-island support. It is a separate module from the admin SPA
(`frontend/`) and the Django backend (`backend/`), and integrates with the
backend **only** through public, read-only APIs.

## Data sources (read-only, unauthenticated)

- `GET /api/v1/website/public/home/` — CMS presentation content (sections,
  banners, process steps, why-choose-us, stats, testimonials, brand logos, FAQ,
  footer, SEO) managed from the admin panel's **Website** menu.
- `GET /api/v1/website/public/catalogue/` — the **live catalogue** from the
  admin **Operations** modules: Service categories, bookable Services (active +
  online-booking-enabled, with a `from_price`) and Subscription plans. These are
  never re-authored here — the site reads them live.

## Develop

```bash
cd web
cp .env.example .env        # set API_BASE_URL to the running Django API
npm install
npm run dev                 # http://localhost:4321
```

`API_BASE_URL` is used for server-side fetches from the SSR runtime, so no CORS
is required for page rendering. All fetches degrade gracefully — a backend
hiccup renders the page with empty sections rather than erroring.

## Build & run (production)

```bash
npm run build               # outputs dist/ (standalone Node server)
SITE_URL=https://deepclean.example API_BASE_URL=https://api.example/api/v1 \
  node ./dist/server/entry.mjs
```

Serve behind nginx/CDN; the Node process handles SSR. Set `SITE_URL` for correct
canonical/Open Graph URLs.

## Structure

```
src/
  layouts/BaseLayout.astro   # html shell, meta/OG, JSON-LD
  components/Header.astro     # logo + nav + Book Now
  components/Footer.astro     # CMS footer + Organization contact/social
  pages/index.astro           # homepage (all sections)
  lib/api.js                  # public API fetch helpers + money()
  styles/theme.css            # brand design tokens
public/logo.png               # brand logo
```
