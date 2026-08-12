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

## D007 — Scheduler feature set: implemented, with four plan corrections

**Date:** 2026-08-12 · **Status:** IMPLEMENTED (branch `maintainer-scheduler`)
**Detail:** [[SCHEDULER_PLAN]] · revises [[DECISIONS#D006]]

All four features shipped: CPU limit, server-side groups + row order, per-group
schedules with run-now and a local state file, TPS measurement + per-group gate.
The decisions below are where the code had to depart from the plan.

**1. Schedule clock is `computer.uptime()`, not the `os.time()` world clock.**
D006 locked "in-game ticks, not real time" and the plan spelled out
`os.time() * 1000 / 60 / 60 - 6000`. That formula reads Minecraft's *time of day*,
which `/time set` moves, players sleeping jumps by ~12k ticks, and
`doDaylightCycle false` freezes outright — a frozen world clock would have frozen
every schedule forever. OC documents `computer.uptime()` as "measured based on the
world time that passed", so it advances with server ticks and gives D006 both of
its stated properties (stretches under lag, no post-freeze burst) while none of
those three things can touch it. `scheduler.ticks()` = `uptime * 20`. The plan's
tick-delta clamping, negative-delta guard and bed-skip cap all became unnecessary
and were dropped rather than written.

**2. TPS is measured against the web server's clock, with a local fallback.**
Consequence of the above: every clock an OC computer can read *is* world time, so
tick-delta-over-uptime is 20 by definition and cannot see lag (the plan's
measurement scheme would have read a constant 20 TPS). Instead the server stamps
each `/api/sync` response with `Date.now()`, the connector relays it as a `now:`
tunnel message every poll, and the maintainer divides game seconds by real seconds
over a rolling 6-sample window. Serverless fallback: write a byte to `/tmp` and
read the file's modification time back, which OC fills in from the host's real
clock (the F4 trick). With neither available TPS reads `nil`, the website shows no
TPS, and **every `min_tps` gate stays open** — a gate must never stop crafting on
a guess.

**3. One source of truth per thing, so two planned columns do not exist.**
`groups.enabled` was dropped: enabling a group already means "toggle every member
target", and a second flag would need a merge rule nobody asked for.
`groups.position` was dropped: row order lives on `targets.position` alone and a
collapsed group draws at its first member's row, so a second ordering could only
desync. `gate JSON` became one `min_tps REAL` column, D006 having narrowed gates
to TPS. `POST /api/groups/import` was dropped: the migration reuses
`PUT /api/groups` + `PUT /api/order` once it sees the server hold no layout.

**4. Group layout writes merge instead of replacing field by field.**
`PUT /api/groups` is still replace-all for membership, but fields the caller omits
keep their stored value, and the browser sends `interval_s`/`min_tps` only for
group ids the server has never seen. Found by test: without this, dragging a
bracket on a page that loaded before somebody set an interval silently wiped that
interval.

**Smaller calls made in passing.** Brackets now draw in Default sort too (with
order server-side, Default *is* the saved order, so only the editing gestures need
Custom) — the localStorage `hasCustomOrder` special case and its Undo toast are
gone. Schedules are edited in a panel below the table rather than in table rows,
because a schedule matters in every sort mode while a bracket only draws in the
ordered ones; collapsed rows keep a "every 600s · checked 23m ago" badge. Per-item
status is sticky per item, so a failure inside a 30-minute group survives the
default schedule's cycles in between. A run-now on a group that has no interval of
its own fires the default schedule (the one its items actually run on); the button
is only offered for groups that have their own. Tunnel framing is size-triggered —
payloads that still fit one packet are sent unframed and receivers pass unframed
messages straight through, so a computer still running the older script keeps
working, as does the legacy `setsleep:` message. `GET /api/status` was added so a
page load shows TPS, CPU counts and check ages immediately instead of after a poll.
An ME interface reporting zero crafting CPUs disables the budget entirely rather
than blocking every request on a number that cannot be trusted.

**Verification.** No harness in the repo; scripts live in the session scratchpad.
54 checks run the real Lua modules in a Lua VM against stubbed OC APIs (chunk
framing/reassembly/interleaving, state round trip, TPS at 20 and 10, CPU budget
under `cpu_limit` ±, per-group intervals, run-now, gate open/closed, serverless
boot, oversized stock reply). 58 checks drive the HTTP API (groups, order,
run-now, cpu_limit validation, live status, tenant isolation on every new route,
thin-group pruning). Client `vite build` clean. The server suite ran against
`node:sqlite` in place of `better-sqlite3`, which cannot compile on this machine
(Node 25, no MSVC) — same SQL, different driver.
