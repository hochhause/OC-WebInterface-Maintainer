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

## D005 — Scheduler feature set: decisions locked (planning, no code)

**Date:** 2026-08-12 · **Status:** APPROVED plan · **Detail:** [[SCHEDULER_PLAN]]

- **CPU limit:** global per network. Budget computed once at cycle start from a
  fresh getCpus read (idle count + managedActive), decremented per submit. Capping
  by idle CPUs even at cpu_limit=0 removes "no free CPU" request failures.
- **Groups move server-side** (currently browser localStorage), custom sort order
  too — also fixes groups not syncing between browsers on the same network.
- **Per-group intervals** run locally on the maintainer (uptime-based), fire only
  from the single main loop (idle-only by construction).
- **Run-now:** per-group + global buttons on the web; server-side run_seq counters
  delivered via the normal connector poll (~10s latency).
- **Local persistence:** maintainer writes every accepted config push to a state
  file, loads on boot -> full function through web outages, serverless mode supported.
- **Time/player gates: DISCARDED** (not worth the time). TPS gating died with it.
- **Delivery: separate PR** on branch maintainer-scheduler cut from main; must
  auto-merge with both main and multiuser-web (new-file isolation, injected
  tenancy resolver, one-line wire-ups only, 3-way local merge test before push).

## D006 — Scheduler plan revisions: tick clock, TPS gate revived, branch retarget

**Date:** 2026-08-12 · **Status:** APPROVED plan (revises [[DECISIONS#D005]]) · **Detail:** [[SCHEDULER_PLAN]]

- **Schedule clock = in-game ticks**, not real time. Rationale (user): schedules
  should stretch when the MC server slows (machines slow too) and must not shift
  or burst after a freeze. worldTicks via os.time() conversion; per-loop delta
  clamped against /time set and bed-skips. Intervals configured in seconds,
  interpreted as game-seconds (x20 ticks).
- **TPS gate revived** (time-of-day + player gates stay discarded): local
  measurement (tick delta vs computer.uptime over rolling window), optional
  per-group min_tps, TPS shown on website. Works serverless.
- **Branch retarget:** maintainer-scheduler now cut from and PRs into
  multiuser-web; main is no longer a merge target. Dual-merge machinery from
  D005 (injected resolver, byte-identical docs, 3-way merge tests) void.
