# Features

## Multi-tenant hosting (2026-08-12, branch `multiuser-web`)

One deployed website serves many isolated AE2 networks. See [[PROJECT_CONTEXT]] · [[DECISIONS#D001]].

- **Network key** — generated on the OC connector by `install-connector`, doubles as
  website login. One key = one network; server derives tenant from the secret,
  never from a URL or body parameter.
- **Auto-registration** — first sync with an unknown key (≥16 chars) creates the
  network. `OPEN_REGISTRATION=false` locks the server afterwards.
- **Scoped live updates** — WebSocket authenticated via session cookie, broadcasts
  only within the tenant.
- **Named-volume persistence** — Docker compose volume `oc-maintainer-data`;
  Railway volume at `/data` via `RAILWAY_VOLUME_MOUNT_PATH`; WAL-mode SQLite.
- **Registry framework** — item registries pluggable per modpack version in
  `server/registries.js` + `client/public/registries/`. Only GTNH 2.9 shipped;
  each network row stores which registry it uses.
- **Modes** — `SINGLE_USER=true` (start.bat): loopback browsers skip login, one
  network. Legacy `.env` installs (`API_KEY`/`BROWSER_PASSWORD`) keep working via
  seeded network `main`.
- **Logout button + login screen** keyed on network key (replaced password login
  and the multi-network dropdown).

## Abuse protection for public hosting (2026-08-12, branch `multiuser-web`)

Agreed with Soy: public instance needs a blunt shield, nothing fancy — tool is
set-and-forget, users tolerate slowdown. See [[DECISIONS#D004]].

- **Per-IP rate limit** — `RATE_LIMIT` (default 60 req/min) over all `/api`
  routes and WS connects; fixed window, in-memory, `Retry-After` on 429, `0`
  disables. Static files exempt (atlas is 24 MB, fetched once).
- **IP blocklist** — `BLOCKED_IPS` comma-separated, 403 on everything incl.
  static + WS. For discovered malicious actors; set var, redeploy.
- **Proxy awareness** — `trust proxy` auto on Railway (`RAILWAY_ENVIRONMENT`),
  opt-in via `TRUST_PROXY=true` behind Caddy/nginx. Without it all visitors
  share the proxy's IP bucket. `::ffff:` IPv4-mapped addresses normalized.
- **Container caps** — compose limits 1.0 CPU / 512 M so a flood pins the
  container, not the host.

### Discarded along the way

- Per-user accounts (user1/user2 on same network are indistinguishable — by design).
- `network_id` config value in connector's config.lua (the key is the identity).
- `/api/networks` endpoint (enumerated all tenants).
- Separate BROWSER_PASSWORD vs API_KEY for new installs (merged into one key;
  kept only for legacy `main`).

## Planned: scheduler feature set (2026-08-12, plan only)

CPU limit · server-side groups · per-group schedules on **in-game tick clock** ·
run-now buttons · local state fallback · per-group TPS gate + live TPS display.
See [[SCHEDULER_PLAN]] · [[DECISIONS#D005]] · [[DECISIONS#D006]]. Ships as
separate branch `maintainer-scheduler`, PR targets `multiuser-web` (not main).

### Discarded at planning

- Time-of-day / players-online gates per group — not worth the time.
  (TPS gate initially discarded with them, revived in D006.)
