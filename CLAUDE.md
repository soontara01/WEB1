# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Node.js + Express 5 app server in TypeScript (ESM) that serves static files from `public/` and a JSON API under `/api`. It is designed to run as many identical instances behind a plain round-robin load balancer: **all shared state lives in MongoDB, which holds only sessions** (`sessions`, via connect-mongo; the CSRF token and the signed-in user live inside the session). Users sign in with **Microsoft Entra ID (OIDC)**; the app stores no users, passwords or tokens. Never add in-process state (memory caches, in-memory stores) that must be consistent across requests.

## Commands

```bash
cp .env.example .env                  # required by `dev` (loaded via node --env-file); needs Entra app registration values
npm run dev                           # tsx watch
npm run build && npm start            # compile to dist/ and run
npm test                              # vitest; uses mongodb-memory-server, no real Mongo needed
npx vitest run tests/auth.test.ts     # single file
npx vitest run -t "shared across app instances"   # single test by name
npm run lint
npm run typecheck                     # includes tests/ (build config only compiles src/)
SESSION_SECRETS=... docker compose up --build     # 2 replicas + nginx on :8080 + mongo
```

Runtime is Node 24 LTS. When changing it, update `Dockerfile` (both stages), `engines` in package.json, `.nvmrc` and `@types/node` together so types never describe a newer Node than production runs.

The first `npm test` may download a mongod binary. npm 11 gates install scripts via `allowScripts` in package.json; esbuild and mongodb-memory-server are approved there — new packages with native/postinstall steps need `npm approve-scripts <pkg>`.

## Architecture

- `src/server.ts` is the only entry with side effects: loads config, connects Mongo, listens, handles SIGTERM/SIGINT graceful shutdown. `src/app.ts` exports `createApp({ config, client, logger, lifecycle?, oidc? })` with no globals, so tests build several independent app instances against one database to simulate horizontal scaling.
- Middleware order in `createApp` matters: logging → helmet → health probes → `express.static` → `/api` router (CORS → JSON body limit → session → CSRF → routes) → 404 → error handler. Probes and static assets deliberately sit before the session so they never hit the session store.
- Config: every env var is declared and validated in `src/config/env.ts` (zod). Add new settings there and to `.env.example`; code reads the typed `Config`, never `process.env`. `loadConfig(env)` accepts an env object, which is how tests override settings (`server.makeApp({ BODY_LIMIT: '1kb' })`).
- `normalizeClientIp` (`src/middleware/clientIp.ts`) runs first and shadows `req.ip` with a port-less address, because Azure Application Gateway sends `X-Forwarded-For: ip:port`. Always use `req.ip`, never parse forwarding headers yourself.
- Shutdown: `server.ts` passes a `lifecycle` object to `createApp`; on SIGTERM it sets `shuttingDown` (so `/readyz` returns 503), keeps serving for `SHUTDOWN_DELAY_MS`, then closes. Deployment requirements for AKS/AGIC are in `docs/deploy-aks.md`.
- Auth (`src/auth/oidc.ts`, `src/routes/auth.ts`): Authorization Code + PKCE via `openid-client`. `GET /api/auth/login?returnTo=` stores state/nonce/verifier in `session.oidc` and redirects to the IdP; `GET /api/auth/callback` validates, regenerates the session and sets `session.user` (`{ id: oid, name, email, roles }`). The redirect URI is built from `PUBLIC_BASE_URL`, never the Host header. Callback uses `response_mode=query` because the SameSite=Lax cookie is not sent on a cross-site form_post. `createApp` takes an `OidcClient`; tests use `FakeOidcClient` (`tests/helpers.ts`) and `tests/oidc.integration.test.ts` runs the real client against `oidc-provider`.
- **No rate limiting in the app, by design.** It is enforced by Application Gateway WAF custom rules (see `docs/deploy-aks.md`); do not add express-rate-limit or similar back.

## Angular apps (SPA_APPS)

Built SPAs are served from directories outside the repo, configured as `SPA_APPS=name:dir,...` (validated in `src/config/env.ts`: reserved names `api`/`healthz`/`readyz`, each dir must contain `index.html`). `src/middleware/spa.ts` mounts each at `/<name>/`:
- Unknown paths without a file extension, or any browser navigation (`Accept: text/html`), return `index.html` so deep links work; missing assets like `main-OLDHASH.js` return 404 JSON instead of HTML.
- Cache: `index.html` `no-cache`; Angular hashed bundles (`-[A-Z0-9]{8}.js|css`) and `media/` are `immutable`; everything else uses `STATIC_MAX_AGE`.
- Apps are public; authorization happens at `/api`. On a 401 an app navigates to `/api/auth/login?returnTo=/<name>/...` (full page navigation, not XHR); the server only accepts same-site paths for `returnTo` (`safeReturnTo`).

Requirements for each Angular project:
- `ng build --base-href /<name>/` with `<name>` matching `SPA_APPS`; output is `dist/<project>/browser`. Run it from PowerShell/cmd, not Git Bash: MSYS path conversion rewrites `/inventory/` to `C:/Program Files/Git/inventory/` (or prefix with `MSYS_NO_PATHCONV=1`). Setting `baseHref` in `angular.json` avoids the flag entirely.
- Set `"optimization": { "styles": { "inlineCritical": false } }` in `angular.json`: critical-CSS inlining emits an inline `onload` handler that the CSP (`script-src-attr 'none'`) blocks, leaving stylesheets unapplied. Do not loosen the CSP instead.
- Call the API with relative URLs (`/api/...`); send `X-CSRF-Token` (from `GET /api/auth/csrf`; fetch it again after sign-in because the session is regenerated) on non-GET requests, typically via an `HttpInterceptor`.

## Security conventions

- State-changing API requests require the `X-CSRF-Token` header matching the session's token (synchronizer pattern, `src/middleware/csrf.ts`). Clients get it from `GET /api/auth/csrf` and must refetch it after sign-in because the session is regenerated.
- On any privilege change call `req.session.regenerate()`; on logout `destroy()` and clear the cookie with `cookieOptions(config)` so attributes match.
- Validate every request body/query with zod schemas before use.
- CSP is `script-src 'self'`: no inline scripts or handlers in `public/`; put JS in separate files.
- In production `COOKIE_SECURE` is forced on; behind a TLS-terminating proxy `TRUST_PROXY` must be set or express-session will not send the cookie.
- Error responses never include 5xx details in production (`src/middleware/errorHandler.ts`); log redacts cookies and the CSRF header.
