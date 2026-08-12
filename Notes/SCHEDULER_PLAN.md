# Plan — CPU limit · per-group schedules · run-now

**Status:** APPROVED 2026-08-12 (decisions locked, see [[DECISIONS#D005]]), no code yet.
Branch `multiuser-web`. See [[DECISIONS#D001]] for tenancy model.
Time/player gates (former Feature 3): **DISCARDED** — not worth the time.

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

## ~~Feature 3 — Time / player-count gates~~  ·  DISCARDED 2026-08-12

Not worth the time (user call). For the record: IRL time was trivial (server
clock), player count needed a Server List Ping from the web server (no survival
OC component exposes it), TPS gating was a fully-local alternative signal.
Revive from git history if ever wanted.

---

## Branch & merge strategy (locked, user requirement)

These features ship as a **separate PR** from the multiuser build and must merge
cleanly with BOTH `main` and `multiuser-web`.

- Branch `maintainer-scheduler`, cut from `main` (not from `multiuser-web`).
- **New-file isolation.** All logic goes in files neither branch touches:
  - `oc-scripts/level-maintainer/src/scheduler.lua`, `src/state.lua` (persistence),
    `src/chunk.lua` (tunnel chunking, shared with connector)
  - `server/groups.js` (schema + queries + routes in one module)
  - `client/src/groups-api.js`
- **Shared files get one-line wire-ups only**, placed at insertion points whose
  surrounding lines are identical in both worlds (end-of-file mounts, top-of-file
  requires). `multiuser-web` rewrote `server/index.js` almost entirely — any edit
  to a rewritten region WILL conflict, so the scheduler branch may not restructure
  shared code, only insert.
- **Tenancy is injected, not assumed.** `server/groups.js` exports
  `mount(app, getNetworkId)`: `main` passes a param-based resolver,
  `multiuser-web` passes `req => req.networkId`. The module itself stays
  identical bytes in both worlds. (Groups schema keys on `network_id`, which
  both worlds already use in every table.)
- **Docs:** this plan file must stay byte-identical on both branches (identical
  additions auto-merge). `DECISIONS.md`/`Features.md` histories stay on
  `multiuser-web` only — appending to them from two branches cannot merge clean.
- **Verification protocol, before every push of the scheduler branch:**
  1. throwaway of `main` + `git merge --no-ff maintainer-scheduler` → must auto-merge
  2. throwaway of `multiuser-web` + same merge → must auto-merge
  3. throwaway of `main` + merge `multiuser-web` + merge `maintainer-scheduler`
     → must auto-merge (final-state simulation)

---

## Order & effort

| # | Work | Size | Depends on |
|---|---|---|---|
| 1 | CPU limit | S (~½ day) | nothing — can ship alone |
| 2 | Groups → server + migration | M-L | nothing |
| 3 | Per-group scheduler + state file + chunked tunnel + run-now | M | 2 |

2+3 is the bulk (~2-4 focused days): the maintainer loop rewrite is easy, the
client group-storage refactor is the grind, and the both-ways merge constraint
adds design tax on the server routes.

## Decisions — RESOLVED 2026-08-12

1. Custom sort order server-side: **YES**.
2. Web outage: maintainer persists last-accepted config locally and runs from it
   indefinitely; serverless operation is a supported mode.
3. CPU limit scope: **global per network**.
4. TPS gating: discarded with Feature 3.
5. Separate PR; branch from `main`; must auto-merge with both target branches.
