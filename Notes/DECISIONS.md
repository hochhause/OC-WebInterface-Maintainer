# Decisions

## D001 — Multi-tenant server: secret determines network

**Date:** 2026-08-12 · **Status:** IMPLEMENTED (branch `multiuser-web`)
**Detail:** [[MULTIUSER_PLAN]]

**Context.** One deployed webserver currently serves exactly one ingame instance.
Goal: one central deployment, many users, isolated by a per-user secret, so users
stop having to self-host.

**Decision.** `network_id` is resolved server-side from a secret and is never
accepted as caller input.
- Browser: session cookie → `sessions` table → `network_id`.
- Connector: `Authorization: Bearer <api_key>` → sha256 → `networks` table → `network_id`.
- `:networkId` is removed from all routes; `network_id` is removed from the `/api/sync` body.

**Why.** The storage layer is already tenant-keyed (`network_id` leads every PK),
so isolation is purely an auth concern. Deriving the tenant from the secret removes
the IDOR and the cross-tenant clobber by construction rather than by validation —
there is no parameter left to tamper with. It also removes the day-one collision
where every shipped `config.lua` defaults to `network_id = "main"`.

**Refined during implementation (user direction):**
- **One key, not two.** The site does not model users — user1 and user2 on the same
  OC instance are indistinguishable. So the connector's api_key doubles as the
  website login; no separate browser password for new installs. Key generated
  in-game by `install-connector` (32 chars), shown once, saved in config.lua.
- Hashing: sha256 only (`node:crypto`). scrypt dropped — with no human-chosen
  passwords left in the design, every credential is a high-entropy machine secret.
- Auto-registration on first sync (key ≥ 16 chars) instead of a signup endpoint;
  `OPEN_REGISTRATION=false` to lock a server down afterwards.
- `SINGLE_USER=true` for local installs: loopback browsers skip login entirely,
  any connector key claims network `main`. start.bat sets it; never for public hosts.
- Sessions persist in SQLite, not memory — a redeploy must not log every user out.
- WebSocket broadcasts scope to `ws.networkId`; WS upgrade requires a valid session.
- Backwards compatibility: env `API_KEY` seeds network `main` at boot; legacy
  `BROWSER_PASSWORD` still logs into `main`. Existing DBs keyed `('main', …)` keep data.

**Rejected.** Validating a caller-supplied `network_id` against the session
(leaves the tamperable parameter in place, one missed route reopens the hole).
Postgres (premature — WAL-mode SQLite covers several hundred tenants at 10s polls).
Separate browser password (no users to separate). scrypt/bcrypt (no low-entropy
credentials remain).

## D002 — SQLite on a named volume

**Date:** 2026-08-12 · **Status:** IMPLEMENTED

`DATA_DIR` env → `RAILWAY_VOLUME_MOUNT_PATH` → `.` fallback, resolved in db.js.
Docker: named volume `oc-maintainer-data` mounted at `/data` (compose + Dockerfile
`VOLUME`). Railway: user mounts a volume at `/data`; the injected
`RAILWAY_VOLUME_MOUNT_PATH` is picked up with zero config. `numReplicas: 1` pinned
in railway.json because SQLite is single-writer. WAL mode + busy_timeout on boot.
**Why:** container filesystems are ephemeral; before this, every redeploy wiped
all tenants' targets.

## D003 — Registry framework, one version shipped

**Date:** 2026-08-12 · **Status:** IMPLEMENTED

Only GTNH 2.9 exists; no backports planned. But registries are a catalog
(`server/registries.js`) + files (`client/public/registries/<id>.json`), and each
network row stores its registry id. `/api/me` tells the client which file and
atlas to load. Adding a version = 1 JSON file + 1 catalog line, no code changes.
The old duplicate copy (`server/data/gtnh_registry.json`) was deleted.

## D004 — Abuse protection: blunt per-IP shield, no dependency

**Date:** 2026-08-12 · **Status:** IMPLEMENTED (branch `multiuser-web`)

**Context.** Discussed with Soy: a public multiuser instance needs protection
against hammering/abuse. Agreed a simple rate limit + container resource caps
suffice — set-and-forget tool, occasional revisits, users tolerate slowdown.

**Decision.** Hand-rolled fixed-window limiter (same style as existing
login/sync limiters), not express-rate-limit:
- `RATE_LIMIT` req/min/IP (default 60) across `/api` + WS connects; `0` off.
- `BLOCKED_IPS` env blocklist → 403 everywhere; edit var + redeploy to ban.
- `trust proxy` auto on Railway / `TRUST_PROXY=true` behind reverse proxy —
  without it every visitor shares the proxy IP bucket and limits misfire.
- `::ffff:` prefixes stripped so human-written blocklist entries match sockets.
- compose caps 1.0 CPU / 512M — flood pins container, not host.

**Why not fancier.** No accounts to key on (see [[DECISIONS#D001]] — keys are the
only identity), traffic profile is tiny (connector 6 req/min), and in-memory
Maps reset on restart which is acceptable for a shield, not an audit system.
