# Upgrading Node to 22 and Astro to 7

Written for whoever does this upgrade, which may not be the person who found
the need for it.

## Why

The customer website is an SSR app, so every one of its dependencies runs in
production. As of 2026-09-22 six advisories remained against it after the
in-place fixes, and **every one of them is held behind the same wall**:

| Astro | Needs Node | Node adapter | Adapter patched? |
| --- | --- | --- | --- |
| 4.16.19 (current) | `^18.17.1 \|\| ^20.3.0 \|\| >=21` | `@astrojs/node` 8 | no |
| 5.18.2 | `18.20.8 \|\| ^20.3.0 \|\| >=22` | 9 | no |
| 6.0.0 | `^20.19.1 \|\| >=22.12.0` | 10 | no |
| **7.3.3** | **`>=22.12.0`** | **11.1.6** | **yes** |

`@astrojs/node` is patched only in 11.1.6, which requires Astro 7, which
requires Node 22.12. There is no intermediate version that clears them, and
the adapter advisories (open redirect on trailing-slash handling, full-read
SSRF in error rendering, cache poisoning on a malformed `if-match`) are the
ones closest to this deployment.

Installing `astro@^7 @astrojs/node@^11 @astrojs/react@^6` resolves cleanly and
reports **0 vulnerabilities**. `astro build` then refuses: *"Node.js v20.18.1
is not supported by Astro! Please upgrade to >=22.12.0."* That is the entire
blocker. React stays on 18; `@astrojs/react@6` still supports it.

**Check Node 20's support status before scheduling this.** Node 20 "Iron" was
scheduled to leave maintenance in April 2026, which would make the production
runtime itself unsupported and unpatched. If that is right it is a stronger
reason to move than the Astro advisories are.

## What is NOT a reason to rush

Most of the Astro advisories do not apply to this site, and it is worth
knowing that before treating this as an emergency:

- **Already mitigated.** The host-header family (reflection, SSRF in error
  rendering, cache poisoning) needs a client-supplied `X-Forwarded-Host`.
  `deploy/nginx.conf` now pins `X-Forwarded-Host`, `-Server` and `-Port` in
  both server blocks, so the header cannot be injected whatever the framework
  does with it. **Confirm the live nginx config has that change** before
  relying on it; the repo file is a template that must be copied.
- **Features this site does not use**, checked by grep: server islands
  (`server:defer`), `astro:assets` and `<Image>`, `transition:*` directives,
  spread props in `.astro` files. That rules out the AVIF remote code
  execution, the sharp and libvips issues, the Cloudflare adapter XSS, the
  server-island parameter replay and several XSS variants.
- **Not running in production.** The dev-server advisories (Vite path
  traversal, esbuild request forgery, Astro dev server arbitrary file read)
  need `astro dev`. Production runs the built node entry.

What remains reachable is the `define:vars` XSS through incomplete `</script>`
sanitisation, used once in `src/components/HomeHero.astro` and fed CMS
content. Exploiting it needs an authenticated admin to author the payload, so
it is an insider or compromised-account risk rather than an anonymous one.

## Order of work

Node first, on its own, so that if the site breaks you know which change did
it.

### 1. Node 22 on the server

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v            # expect v22.x, >= 22.12
```

Then rebuild both front ends and restart, WITHOUT touching any package
version. Astro 4 supports `>=21.0.0`, so it runs on Node 22 unchanged:

```bash
cd /opt/clubbooking/frontend && npm ci && npm run build
cd /opt/clubbooking/web      && npm ci && npm run build
sudo systemctl restart clubbooking-website clubbooking-web
curl -sI https://sbmweb.veuz.sa/ | head -3       # expect 200
```

Stop here for a day. If the site is healthy, Node is not the problem for
anything that follows.

Update `deploy/DEPLOYMENT.md`, which still installs `setup_20.x`.

### 2. Astro 4 to 7

Three majors. Do it on a branch.

```bash
cd web
npm install astro@^7 @astrojs/node@^11 @astrojs/react@^6
npm run build
```

What this project does NOT have, which removes most of the usual migration
pain: no content collections (the largest change in Astro 5), no
`Astro.glob`, no `ViewTransitions`, no `output: 'hybrid'`. `astro.config.mjs`
uses `output: 'server'` with `node({ mode: 'standalone' })` and the React
integration, and nothing else.

Read the 5, 6 and 7 migration guides rather than guessing. Pay attention to:

- `output: 'server'` semantics and whether `export const prerender = false`
  on the twelve `src/pages/api/*.js` endpoints is still required or now
  redundant;
- the endpoint signature, since every one of those files returns a `Response`
  built by hand;
- `src/pages/pay/split/[token].astro` and `manage/[token].astro`, which read
  a dynamic route param and fetch server-side;
- `astro.config.mjs` options that may have been renamed or removed.

### 3. Verify

`npm run check` covers the checkout contracts and translation parity, but it
renders components in isolation. It will not catch a routing or SSR
regression, so drive the real thing:

- the booking wizard through all five steps, including the calendar marks and
  the scarcity labels;
- a split checkout, and a payment link opened in a second browser;
- `/pay/split/<token>` and the organizer's `manage` page;
- the 404 page;
- both languages, since the site is RTL in Arabic;
- 375px and desktop.

`frontend/e2e/` has a Playwright setup that can drive the site if you point it
at the Astro preview; see the probes used when the calendar marks were added.

### 4. Finally

```bash
npm audit          # expect 0
```

Then deploy through the normal release, and re-run `manage.py check --deploy`
filtered through `grep -v drf_spectacular`.
