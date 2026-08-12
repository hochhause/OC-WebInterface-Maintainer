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

## Scheduler feature set (2026-08-12, branch `maintainer-scheduler`)

See [[SCHEDULER_PLAN]] · [[DECISIONS#D005]] · [[DECISIONS#D006]] · [[DECISIONS#D007]].
PR targets `multiuser-web`, not main.

- **CPU limit** — `cpu_limit` per network in the toolbar. `0` = only the floor
  that always applies (never submit into zero free crafting CPUs, which is what
  used to fill the screen with "failed to request"). `+N` = never run more than N
  of our own jobs at once. `-N` = always leave N CPUs free for players. Budget is
  computed once per cycle from a fresh `getCpus()` read and spent down per
  request; anything left over is reported as **waiting for CPU** (amber row, own
  status count) instead of a failure, and retried next cycle.
- **Groups live on the server** — membership on `targets.group_id`, row order on
  `targets.position`. Both used to be per-browser localStorage, so the maintainer
  could not see them and two browsers on one network disagreed. Existing layouts
  are uploaded once on first load and the local copies deleted. Brackets now draw
  in Default sort as well; Custom is what enables the editing gestures.
- **Per-group schedules** — a group can check every N seconds instead of riding
  the default interval. Clock is the in-game one (`computer.uptime()`), so a
  schedule stretches when the server lags and does not burst after a freeze
  ([[DECISIONS#D007]]). All AE2 work stays in the single main loop, so a timer
  coming due during a heavy cycle waits for the next pass by construction.
  Collapsed group rows show "every 600s · checked 23m ago" so stale counts do not
  read as a bug.
- **Run now** — one button for the default schedule, one per group that has its
  own interval. Server bumps a counter, the maintainer notices it on its next
  poll (≤10s at defaults) and moves that timer to now; the button shows
  "queued..." until a check that happened after the click is reported.
- **Local state file** — every accepted config push is written to
  `/home/maintainer-state.lua` and loaded on boot. A web outage costs nothing,
  and a fully serverless install (no connector at all) is a supported mode: edit
  that file, or delete it to fall back to `config.lua`, which now also takes
  `cpu_limit`, group ids per item and a `groups` table.
- **TPS gate + live TPS** — measured in-game against the web server's clock
  (relayed each poll), or a `/tmp` file-mtime probe when running serverless.
  Optional `min_tps` per group holds that group back while the server is slower
  than the threshold; unknown TPS always counts as open. Current TPS and busy/total
  CPUs show in the website header.
- **Chunked tunnel protocol** — config pushes and stock replies are split into
  frames when they outgrow OpenComputers' 8192-byte packet limit, which large
  target lists were already flirting with. Payloads that still fit are sent
  unframed, so one computer can lag a version behind.

### Discarded at planning

- Time-of-day / players-online gates per group — not worth the time.
  (TPS gate initially discarded with them, revived in D006.)
- `groups.enabled` and `groups.position` columns, and `POST /api/groups/import`
  — each would have been a second source of truth for something that already had
  one ([[DECISIONS#D007]]).
