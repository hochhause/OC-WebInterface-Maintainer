# Plan — CPU limit · per-group schedules · time/player gates

**Status:** PROPOSED, no code. Branch `multiuser-web`. See [[DECISIONS#D001]] for tenancy model.

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

**Mechanic (maintainer, inside existing cycle):**
- `+X`: count of `managedActive` (already computed each cycle,
  [maintainer.lua:160-163](../oc-scripts/level-maintainer/maintainer.lua)) ≥ X → skip
  further `requestItem/requestFluid` this cycle.
- `-X`: `idle = #getCpus() - busy` (busy = `finalOutput() ~= nil`, F2); before EACH
  submit require `idle > X`, decrement local `idle` after a successful submit.
- New per-item status `waiting_cpu` in the status payload → web shows amber "waiting
  for CPU" instead of nothing.

**Precision note:** `craftingCache` TTL is 30s — stale counts could over-submit.
Fix: refresh CPU state once at cycle start + decrement locally per submit within the
cycle (no extra ME calls mid-cycle). Races with players submitting crafts manually
are inherent and acceptable (limit is a courtesy, not a mutex).

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

**Scheduler (maintainer) — respects the single-thread/idle-only constraint you set:**

```
loop:
  now = computer.uptime()                     -- monotonic, survives nothing: fine
  due = groups where now >= nextRun[g] (ungrouped items = virtual group
        with interval = maintainer_sleep, exactly today's behavior)
  for g in due: stock-check + request ONLY g's items (CPU limit applies)
               nextRun[g] = now + interval[g]
  rebuild status/stock cache, draw screen
  os.sleep(min(time until next due, 5s floor))
```

All AE2 work stays in the one main loop, so "timers only fire when idle" holds *by
construction* — a 30-min group coming due during a heavy cycle simply waits for the
next loop iteration. Not second-exact, per your spec. Reboot ⇒ everything due at
once ⇒ acceptable (one full check).

**Consequence to surface in UI:** stock counts for a 30-min group are up to 30 min
stale on the website. Status payload gains `last_checked` per group; web renders
"checked 23m ago" on collapsed group rows. Without this, stale counts look like bugs.

**Protocol:** sync response + tunnel push gain `groups:[{id, interval_s, gate_open}]`
and `group_id` per target. Tunnel messages get chunked (`part i/n` + reassembly,
~20 lines each side) — fixes the pre-existing F3 risk while we're in there.

**Touches:** db.js, 4-5 API routes, client group code rewrite (localStorage → API,
the drag/drop handlers keep their shape, only load/save changes), connector
passthrough, maintainer scheduler, chunking both sides.

---

## Feature 3 — Time / player-count gates per group  ·  size M

**Answer to the feasibility question:**

| Signal | From OC? | Verdict |
|---|---|---|
| IRL time | No (F4) | **Trivial via web server** — it IS a real computer with a real clock. Zero new parts. |
| Players online | No (F5) | **Not from OC in survival.** But the web server can query the MC server's public address with a Server List Ping (status protocol, unauthenticated, ~50 lines of raw TCP, no dependency) → `players.online`. |
| Server load (the real goal?) | Yes | TPS estimate, fully local: world-time progression (`os.time`) vs real seconds (`computer.uptime`) drift ⇒ current TPS. No config, works offline. |

**Design — evaluate gates on the web server, ship booleans:**
- Group gate config (JSON): `{windows:[{days,from,to}], tz, min_players, max_players}`
- Server evaluates each sync → `gate_open: bool` per group. Maintainer just consumes it.
- Why server-side: single source of real time, per-network `tz` (IANA name — server
  may run UTC, user thinks in local time), SLP result cached ~60s, and the OC side
  stays dumb.
- **Failure mode:** web unreachable → maintainer keeps last-known gate states and
  local intervals keep running; maintainer with no web configured at all → gates
  default OPEN. (Standalone operation stays intact — the two-computer isolation
  argument, C2.)
- SLP needs per-network `mc_host:mc_port` setting + only works for publicly
  pingable servers. Singleplayer: player gate is meaningless anyway; time gate
  still works. TPS gate could be added later as a local alternative — out of
  scope for v1 unless you want it.

**Touches:** gate evaluator + SLP client on server, group settings UI (time window
picker, player min/max), settings columns. Cheap *once Feature 2 exists*.

---

## Order & effort

| # | Work | Size | Depends on |
|---|---|---|---|
| 1 | CPU limit | S (~½ day) | nothing — can ship alone |
| 2 | Groups → server + migration | M-L | nothing |
| 3 | Per-group scheduler + chunked tunnel | M | 2 |
| 4 | Time/player gates | M (~1 day) | 2, 3 |

Feature 2+3 is the bulk (~2-4 focused days): the maintainer loop rewrite is easy,
the client group-storage refactor is the grind.

## Open decisions (need your call before coding)

1. **Custom sort order server-side too?** Plan assumes YES (groups break otherwise).
2. **Gate on web outage:** keep last-known state indefinitely (plan assumes this) or
   fail open after N hours?
3. **CPU limit scope:** global per network (plan assumes) or per-group later?
4. **TPS-based gating** as a v1 alternative to player count, or later/never?
