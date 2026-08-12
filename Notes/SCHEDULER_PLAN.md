# Plan — CPU limit · per-group schedules · run-now · TPS gate

**Status: IMPLEMENTED** 2026-08-12 on branch `maintainer-scheduler`.
Planned + revised the same day ([[DECISIONS#D005]], [[DECISIONS#D006]]); what the
code does differently is recorded in **[[DECISIONS#D007]]** — read that alongside
this file, four things below did not survive contact:

1. The schedule clock is `computer.uptime() * 20`, not the `os.time()` world-tick
   formula in Feature 2 (that clock is `/time set`-able, bed-skippable and
   freezable by `doDaylightCycle false`). The clamping described here is therefore
   unnecessary and does not exist.
2. TPS is measured against the web server's `Date.now()` relayed by the connector
   (or a `/tmp` mtime probe when serverless), not against a world-tick delta — the
   latter is 20 by construction. Unknown TPS = gate open.
3. `groups.enabled`, `groups.position` and `POST /api/groups/import` were dropped
   as second sources of truth; `gate JSON` is a single `min_tps` column.
4. `PUT /api/groups` merges omitted fields instead of nulling them.

Time-of-day / player-count gates: **DISCARDED**. TPS gate: **REVIVED** (D006).
See [[DECISIONS#D001]] for the tenancy model this builds on.

## Verified facts (read from code, 2026-08-12)

- **F1 — Groups are browser-local.** `maintainer_groups_${networkId}` and
  `maintainer_custom_order_${networkId}` live in localStorage
  ([main.js:505-530](../client/src/main.js)). Shape: `{id:int, name, labels:[], collapsed}`.
  Consequence: the maintainer has never heard of groups; two browsers on the same
  network already see *different* groups today.
- **F2 — CPU data is already read.** `ae2.crafting()` calls `ME.getCpus()` and walks
  `v.cpu.finalOutput()` per CPU ([ae2.lua:156-173](../oc-scripts/level-maintainer/src/ae2.lua)).
  Total/busy/idle CPU counts are one loop over data we already fetch. No new hardware,
  no new driver capability needed.
- **F3 — Tunnel packets are single-shot.** `pushTargets` and the `requeststock` reply
  each send ONE serialized blob over the linked card. OC default
  `maxNetworkPacketSize` = 8192 bytes. Large target lists already flirt with this
  limit; group metadata adds more. Protocol change must include chunking.
- **F4 — OC has no wall clock.** `os.time()` is in-game time. Real time must come
  from outside (web server) or the tmpfs-mtime trick.
- **F5 — OC has no player list in survival GTNH.** Debug card (`getPlayers()`) is
  creative-only; motion sensor is 8-block local movement. No survival component
  exposes online player count.

---

## Feature 1 — CPU limit  ·  size S

**Config:** `cpu_limit` int per network. `0` = off. `+X` = at most X simultaneous
jobs *started by this maintainer*. `-X` = always leave X CPUs idle for humans.

**Mechanic (locked): compute a job budget once at cycle start, spend it down.**

```
at cycle start (fresh getCpus read, ignore 30s cache):
  idle          = #cpus - busy            (busy = finalOutput() ~= nil, F2)
  budget        = idle                    -- never submit into 0 free CPUs
  if cpu_limit > 0: budget = min(budget, cpu_limit - #managedActive)
  if cpu_limit < 0: budget = min(budget, idle - |cpu_limit|)
each successful request: budget -= 1; budget == 0 → stop submitting this cycle
```

Side benefit (user-called): capping by `idle` even with `cpu_limit=0` eliminates
the current "failed to request" spam when all CPUs are occupied — requests that
can't get a CPU are simply deferred to the next cycle as `waiting_cpu`.

- New per-item status `waiting_cpu` in the status payload → web shows amber
  "waiting for CPU" instead of a failure.
- Races with players submitting crafts manually mid-cycle are inherent and
  acceptable (limit is a courtesy, not a mutex).
- Scope: **global per network** (locked).

**Touches:** ae2.lua (+~15 lines `idleCpus()`), maintainer loop gate (+~15), settings
table + one column, settings UI field, sync payload field.

---

## Feature 2 — Per-group schedule  ·  size L (the big one)

**Prerequisite that dominates the cost: groups move server-side** (F1). Without
this the maintainer can't know groups exist. Moving them also fixes the existing
wart that groups/order are per-browser, which is wrong under multi-user anyway.

**DB:**
- `groups(network_id, id, name, position, collapsed, interval_s NULL, gate JSON NULL, enabled)`
- `targets.group_id` FK NULL (NULL = ungrouped)
- custom sort order moves server-side too (`targets.position`) — groups reference
  row order; splitting their storage across server/browser would desync them.
- One-time migration: client finds localStorage groups + server has none → POST
  `/api/groups/import`, then deletes local copy.

**Schedule clock: in-game ticks, not real time (locked, D006).**
Rationale (user): if the MC server slows down, machines craft slower too — the
schedule should stretch with them; and after a freeze the schedule must not shift
or burst. Ticks give both for free:

- World ticks from Lua: `os.time() * 1000 / 60 / 60 - 6000` (documented OC
  conversion; `os.time()` is game time). Wrapped as `worldTicks()` in scheduler.lua.
- Intervals configured in seconds on the web, interpreted as *game seconds*:
  `interval_ticks = interval_s * 20`. At 20 TPS identical to real time; at 10 TPS
  a "60s" group checks every 120 real seconds — matching the halved machine speed.
- **Freeze behavior:** OC computers only execute during server ticks, and world
  time doesn't advance while frozen ⇒ after recovery the tick delta is ~0: no
  overdue burst, no shift. (A real-time clock would see the whole freeze as
  elapsed and fire everything at once.)
- **Clamping:** per loop iteration, `delta = clamp(worldTicks() - lastTicks, 0, cap)`.
  Negative (admin `/time set` backwards) ⇒ 0; huge positive (players sleeping in
  beds skips ~+12k world ticks, `/time set day`) ⇒ capped to a few loop-lengths,
  so a bed-skip nudges schedules by seconds, not hours.

```
loop:
  delta   = clampTickDelta(worldTicks() - lastTicks); lastTicks = worldTicks()
  gameNow = gameNow + delta
  due = groups where gameNow >= nextRun[g] and (no min_tps or tps() >= min_tps)
        (ungrouped items = virtual group with interval = maintainer_sleep,
         exactly today's behavior)
  for g in due: stock-check + request ONLY g's items (CPU budget applies)
               nextRun[g] = gameNow + interval_ticks[g]
  rebuild status/stock cache, draw screen
  os.sleep(min(estimated real seconds until next due, 5s floor))
```

All AE2 work stays in the one main loop, so "timers only fire when idle" holds *by
construction* — a 30-min group coming due during a heavy cycle simply waits for the
next loop iteration. Not second-exact, per your spec. Reboot ⇒ everything due at
once ⇒ acceptable (one full check).

**Consequence to surface in UI:** stock counts for a 30-min group are up to 30 min
stale on the website. Status payload gains `last_checked` per group; web renders
"checked 23m ago" on collapsed group rows. Without this, stale counts look like bugs.

**Protocol:** sync response + tunnel push gain `groups:[{id, interval_s, run_seq}]`
and `group_id` per target. Tunnel messages get chunked (`part i/n` + reassembly,
~20 lines each side) — fixes the pre-existing F3 risk while we're in there.

**Run-now buttons (locked, user request):**
- Website: one global button (fires the default schedule — ungrouped items plus
  groups without a custom interval) and one button per group that has its own
  interval.
- Mechanic: server keeps a `run_seq` counter per group + one for the default
  schedule; the button bumps it (`POST /api/run-now[/:groupId]`). Counters ride
  the normal sync response; the maintainer remembers the last seq it saw per
  group and when a counter increases sets that group's `nextRun = now`.
- Latency = one connector poll (≤10s at defaults) — the button shows "queued…"
  until the next stock push confirms, so it doesn't feel dead.
- Reboot loses the maintainer's seq markers → at worst one redundant check cycle
  after reboot. Harmless, no persistence needed for the seqs themselves.

**Local persistence / serverless mode (locked, user requirement):**
The maintainer writes every accepted config push (targets, groups, intervals,
cpu_limit) to a local state file and loads it on boot. Consequences:
- Prolonged web outage: maintainer keeps running its full schedule from the
  local copy — the web is a *editor* for the config, not its runtime home.
- Fully serverless use stays possible: no connector, hand-edit the state file
  (or keep the legacy `config.lua` items table as the seed).
- File lives on the maintainer's disk (`/home/maintainer-state.lua`,
  `serialization.serialize` format, human-editable).

**Touches:** db.js, 4-5 API routes (+run-now), client group code rewrite
(localStorage → API, the drag/drop handlers keep their shape, only load/save
changes), run-now buttons, connector passthrough, maintainer scheduler + state
file, chunking both sides.

---

## Feature 3 — TPS gate per group  ·  size S  ·  REVIVED (D006)

Time-of-day and player-count gates stay **DISCARDED** (IRL time was trivial via
server clock; player count needed a Server List Ping — no survival OC component
exposes it). TPS gating survived review: it targets the actual concern (server
load) and is fully local.

- **Measurement (maintainer, no config):** rolling window of
  `(computer.uptime(), worldTicks())` samples → `tps = Δticks / Δreal_seconds`,
  clamped to [0, 20], bed-skip/`/time set` outlier samples discarded (same clamp
  as the scheduler clock). ~20 lines in scheduler.lua, uses values already read.
- **Gate:** optional `min_tps` per group — group's timer only fires while
  measured TPS ≥ threshold. Evaluated locally each loop; persisted in the state
  file like every other group setting; works serverless.
- **Bonus:** current TPS rides the status payload → website header shows live
  server TPS measured from inside the game.
- Note the interplay: tick-based intervals already *stretch* under lag; `min_tps`
  additionally *stops* a group entirely below the threshold. Both defaults off
  (`min_tps = nil`).

---

## Branch & merge strategy (REVISED, D006)

These features ship as a **separate PR targeting `multiuser-web`** — NOT current
`main`. `main` stays legacy single-tenant and gets neither feature set directly;
it receives everything when the multiuser PR eventually lands.

- Branch `maintainer-scheduler`, cut from `multiuser-web` HEAD, kept downstream
  (merge `multiuser-web` forward into it when the parent moves).
- PR: `maintainer-scheduler` → `multiuser-web` (opened once code exists).
- The dual-merge constraints from the first version of this plan (new-file
  isolation as a hard rule, injected tenancy resolver, byte-identical docs,
  3-way merge tests) are **void** — the branch simply builds on the multiuser
  world and uses `req.networkId` directly. New-file layout (scheduler.lua,
  state.lua, chunk.lua, server/groups.js) is kept anyway as plain good structure.
- Docs (`DECISIONS.md`, `Features.md`, this file) may now be edited on either
  branch — single lineage, no conflict trap.

---

## Order & effort

| # | Work | Size | Depends on |
|---|---|---|---|
| 1 | CPU limit | S (~½ day) | nothing — can ship alone |
| 2 | Groups → server + migration | M-L | nothing |
| 3 | Per-group scheduler (tick clock) + state file + chunked tunnel + run-now | M | 2 |
| 4 | TPS measurement + per-group min_tps + web TPS display | S | 3 |

2+3 is the bulk (~2-4 focused days): the maintainer loop rewrite is easy, the
client group-storage refactor is the grind.

## Decisions — RESOLVED 2026-08-12 (revised same day, D006)

1. Custom sort order server-side: **YES**.
2. Web outage: maintainer persists last-accepted config locally and runs from it
   indefinitely; serverless operation is a supported mode.
3. CPU limit scope: **global per network**.
4. Schedule clock: **in-game ticks** (stretch with lag, no post-freeze burst).
5. TPS gating: **revived** — local measurement, optional per-group `min_tps`.
6. Separate PR on `maintainer-scheduler`, cut from and targeting `multiuser-web`;
   `main` is no longer a merge target.
