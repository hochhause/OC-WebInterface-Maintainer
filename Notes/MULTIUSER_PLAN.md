# Multi-Tenant Web Server — Feasibility & Plan

Branch: `multiuser-web` · Status: PLAN (not implemented) · Date: 2026-08-12

Related: [[DECISIONS#D001 Multi-tenant server]] · [[PROJECT_CONTEXT]] · [[Features]]

---

## S — Verdict

**Feasible. Low-to-medium effort.** The persistence layer is already multi-tenant;
only the auth/authz/transport layer is single-tenant.

`network_id` is the first column of every PK in [db.js](../server/db.js):

```
targets  PK (network_id, label)
stock    PK (network_id, label)
settings PK (network_id)
```

Every query already filters by it. Every route already takes `:networkId`.
The client already has a network selector. **No schema migration of existing
tables is required.** The work is: make `network_id` *derived from a secret*
instead of *asserted by the caller*, and stop broadcasting across tenants.

Estimate: **~350–450 changed lines / 6 files**. 1–2 focused days, or ~4h if the
self-serve registration UI is dropped in favour of an admin-provisioned key.

---

## C — Gap analysis (what blocks multi-user today)

Severity: **P0** = data leak / cross-tenant corruption, **P1** = breaks at scale, **P2** = polish.

| # | Sev | Gap | Location |
|---|-----|-----|----------|
| 1 | P0 | **WS broadcasts every tenant's stock+targets to every connected browser.** Client filters by `network_id` *after* receipt — cosmetic only. Payloads are already in the other tenant's browser. | [index.js:74-79](../server/index.js#L74-L79), [main.js:304](../client/src/main.js#L304) |
| 2 | P0 | **WS connections are entirely unauthenticated.** `wss.on('connection')` only wires an error handler. No cookie check, no path restriction. Anyone with the URL gets the firehose from #1 without logging in. | [index.js:179-181](../server/index.js#L179-L181) |
| 3 | P0 | **No authorization on `:networkId`.** Every route reads the network from the URL path and checks nothing. Any logged-in user can read/write/delete any other network's targets. Textbook IDOR. | [index.js:114-177](../server/index.js#L114-L177) |
| 4 | P0 | **`network_id` is self-asserted by the connector.** `/api/sync` trusts `req.body.network_id` under one shared `API_KEY`. Any connector can claim any network and clobber its stock. | [index.js:81-83](../server/index.js#L81-L83), [connector.lua:60](../oc-scripts/web-connector/connector.lua#L60) |
| 5 | P0 | **Default `network_id = "main"` for everyone.** Shipped config default. Two users onboarding to one host collide immediately and overwrite each other. This is the failure that would hit on day one. | [config.lua:4](../oc-scripts/web-connector/config.lua#L4) |
| 6 | P0 | **Single global `BROWSER_PASSWORD` + single global `API_KEY`.** One secret pair for the whole deployment — no per-user separation exists to enforce. | [index.js:24-26,65-72](../server/index.js#L24-L26) |
| 7 | P1 | **Sessions are an in-memory `Set` of bare tokens.** No identity attached, no expiry, unbounded growth, wiped on every redeploy → all users logged out on each deploy. | [index.js:28](../server/index.js#L28) |
| 8 | P1 | `/api/networks` returns `SELECT DISTINCT network_id FROM stock` — enumerates all tenants. | [db.js:47](../server/db.js#L47) |
| 9 | P1 | No SQLite WAL mode. Sync writes are serialized against reads; with N tenants polling this becomes the throughput ceiling. | [db.js:3](../server/db.js#L3) |
| 10 | P1 | No brute-force protection on `/api/login`; no request size cap (`express.json()` default 100kb, unstated). | [index.js:45,106](../server/index.js#L106) |
| 11 | P2 | Cookie set without `sameSite` / `secure` / `maxAge`. | [index.js:110](../server/index.js#L110) |
| 12 | P2 | `lastSync` / `lastStockStr` keyed by network, never evicted → slow leak per dead tenant. | [index.js:51-52](../server/index.js#L51-L52) |
| 13 | P2 | Item registry is a single shipped `gtnh_registry.json` (GTNH 2.9). Multi-user ⇒ mixed modpack versions. Out of scope, but it becomes a support question. | [gtnh_registry.json](../client/public/gtnh_registry.json) |

---

## D — Target design

### Core inversion

> **The secret determines the network. The network is never accepted as input.**

Kill `:networkId` from every browser route and `network_id` from the sync body.
Resolve it server-side: session cookie → network (browser), API key → network
(connector). This deletes gaps 3, 4 and 5 structurally rather than by validation
— there is no parameter left to tamper with.

### Schema additions (additive only, existing tables untouched)

```sql
CREATE TABLE networks (
  id           TEXT PRIMARY KEY,   -- server-generated slug, e.g. "n_7f3a9c21"
  name         TEXT NOT NULL,      -- user-facing display label
  pass_salt    TEXT NOT NULL,      -- browser password: scrypt
  pass_hash    TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,      -- connector key: sha256 (high-entropy token)
  created_at   INTEGER NOT NULL,
  last_sync_at INTEGER
);
CREATE UNIQUE INDEX idx_networks_api ON networks(api_key_hash);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  network_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
```

**Hashing choice — no new dependencies.** `node:crypto` only.
- Browser password → `scryptSync` + per-row salt + `timingSafeEqual`. Low-entropy human input, needs the work factor.
- Connector API key → server-generated 32-byte token, so `sha256` is sufficient and lets `/api/sync` do one indexed lookup. Deliberate: scrypt on the sync hot path would burn CPU every 10s × every tenant for no security gain on a 256-bit random token.

### Auth flows

```
REGISTER  POST /api/register {name, password[, invite]}
          → server generates id + api_key
          → returns api_key ONCE + a paste-ready config.lua snippet

LOGIN     POST /api/login {network_name|id, password}
          → scrypt verify → insert session row → Set-Cookie
             (HttpOnly, SameSite=Lax, Secure when proto=https, Max-Age=30d)

BROWSER   cookie → sessions lookup → req.networkId   (401 if absent/expired)
CONNECTOR Bearer <api_key> → sha256 → networks lookup → req.networkId (401 if no match)
```

### Route changes

| Now | After |
|-----|-------|
| `GET /api/targets/:networkId` | `GET /api/targets` |
| `POST /api/targets/:networkId` | `POST /api/targets` |
| `PUT /api/targets/:networkId/:label` | `PUT /api/targets/:label` |
| `DELETE /api/targets/:networkId/:label` | `DELETE /api/targets/:label` |
| `GET /api/stock/:networkId` | `GET /api/stock` |
| `GET/PUT /api/settings/:networkId` | `GET/PUT /api/settings` |
| `GET /api/networks` → all tenants | `GET /api/me` → `{id, name, last_sync_at}` |
| `POST /api/sync` + body `network_id` | `POST /api/sync`, network from Bearer key |

### WebSocket

```js
const wss = new WebSocketServer({ server, path: '/ws' })
wss.on('connection', (ws, req) => {
  const netId = networkFromCookie(req)         // reuse the HTTP session lookup
  if (!netId) return ws.close(4001, 'unauthorized')
  ws.networkId = netId
})

function broadcast(networkId, data) {
  const m = JSON.stringify(data)
  for (const c of wss.clients)
    if (c.readyState === 1 && c.networkId === networkId) c.send(m)
}
```
Every existing `broadcast(...)` call site already has the network in scope — the
change is mechanical. The client-side `if (msg.network_id !== networkId) return`
guard stays as belt-and-braces but stops being the only barrier.

### Backwards compatibility — local/single-player keeps working

On boot: if `BROWSER_PASSWORD` and/or `API_KEY` are present in env **and** no
network with id `main` exists → seed one (`id='main'`, name `'main'`, hashes
derived from those env vars). Existing rows are already keyed `('main', label)`,
so **existing local DBs keep all their data and `start.bat` needs no change**.
Env vars stay the source of truth for that row on every boot, so editing
`server/.env` still works exactly as the README documents.

Optional `REGISTRATION_OPEN=false` / `REGISTRATION_CODE=<str>` to gate signups on
a public host.

### Lua connector changes (~5 lines)

```lua
return {
  server  = "https://your-app.up.railway.app",
  api_key = "paste-the-key-the-site-gave-you",   -- now identifies the network
  -- network_id removed: the key determines it
  poll_interval = 10,
  tunnel_timeout = 8,
}
```
`connector.lua` drops `network_id = cfg.network_id` from the sync body. Nothing
else changes — the maintainer OC is behind the linked card and is untouched.

---

## R — Risks

| Risk | Mitigation |
|------|-----------|
| **Silent cross-tenant clobber if `network_id` stays caller-supplied** — the single highest-consequence outcome, and invisible until someone's stock list is overwritten | Server-derived network only. Non-negotiable; it is the whole point of the redesign. |
| Redeploy logs everyone out | Sessions in SQLite, not memory (gap 7). |
| Railway free tier: SQLite file needs a mounted volume or data is lost on redeploy | `DATA_DIR` already supported — must be documented as **required** for multi-user, not optional. Verify the volume before inviting users. |
| Password brute force on a public host | Per-IP throttle on `/api/login` + `/api/register`; reuse the existing `rateLimit` shape. |
| Registration spam filling the DB | `REGISTRATION_CODE` env gate. |
| SQLite write contention as tenants grow | `PRAGMA journal_mode=WAL`. At 10s polls with small payloads this holds to several hundred tenants on one instance; beyond that, move to Postgres — but that is a later problem, not this change. |
| Users on different GTNH versions vs. the single shipped registry | Out of scope. Note in README. Later: per-network registry upload. |
| API key leaks via in-game `config.lua` on a shared MC server | Separate browser password from connector key (this design does), so a leaked connector key does not hand over the web UI. Add key rotation later. |

**N — Not in scope:** email/accounts, password reset, Postgres migration, per-network registry uploads, admin dashboard, key rotation UI.

---

## O — Workload breakdown

| File | Change | ~LOC |
|------|--------|------|
| [server/db.js](../server/db.js) | `networks` + `sessions` tables, hash helpers, queries, WAL | +110 |
| [server/index.js](../server/index.js) | register/login, two auth middlewares, drop `:networkId`, scoped broadcast, WS auth, cookie flags, throttle, env seed | +130 / −45 |
| [client/src/main.js](../client/src/main.js) | login form (+network field), register/setup screen, drop networkId from URLs, replace network bar with network name, show `/api/me` | +110 / −40 |
| [client/src/style.css](../client/src/style.css) | register/setup screen styling | +40 |
| [oc-scripts/web-connector/config.lua](../oc-scripts/web-connector/config.lua) + [connector.lua](../oc-scripts/web-connector/connector.lua) | drop `network_id` | −3 |
| [README.md](../README.md) | hosted multi-user flow, `DATA_DIR` requirement | +50 |

**Total ≈ 350–450 lines, 6 files.**

### Suggested order (each step independently testable)

1. **Schema + hash helpers** in `db.js`. No behaviour change yet.
2. **Env seeding** of network `main`. Verify the existing local DB still loads.
3. **Auth middlewares + register/login.** Old routes still work.
4. **Drop `:networkId`** from routes, switch to `req.networkId`. Client updated in the same step.
5. **WS auth + scoped broadcast.** ← the P0 leak closes here.
6. **Connector lua + README.**
7. **Hardening:** throttle, cookie flags, WAL, body limit, session sweep.

Steps 1–5 are the functional change; 6–7 are ship prerequisites for a public host.

### P — Verification

No test harness exists in this repo. Manual proof, two browsers + two `network_id`s:
- Log into A → `/api/targets` returns only A's rows; no path exists to request B's.
- A and B both open; edit a target in B → **A's WS receives nothing** (check devtools frames, not just the rendered table).
- WS connect with no cookie → closed with 4001.
- Connector with a wrong/blank key → 401, no row written.
- Two connectors, two keys, concurrent sync → no cross-writes.
- Existing local DB + unchanged `server/.env` → all prior targets still present after upgrade.
