# Decisions

## D001 — Multi-tenant server: secret determines network

**Date:** 2026-08-12 · **Status:** PROPOSED (branch `multiuser-web`, not implemented)
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

**Also decided:**
- Hashing via `node:crypto` only — no new dependency. scrypt for the human-chosen
  browser password, sha256 for the server-generated API key (keeps `/api/sync`,
  the hot path, to one indexed lookup).
- Sessions persist in SQLite, not memory — a redeploy must not log every user out.
- WebSocket broadcasts scope to `ws.networkId`; WS connections require a valid session.
- Backwards compatibility: if `BROWSER_PASSWORD`/`API_KEY` env vars exist at boot,
  seed network `main` from them. Existing local DBs are already keyed `('main', …)`,
  so local/single-player setups upgrade with no data loss and no `start.bat` change.

**Rejected.** Validating a caller-supplied `network_id` against the session
(leaves the tamperable parameter in place, one missed route reopens the hole).
Postgres (premature — WAL-mode SQLite covers several hundred tenants at 10s polls).
bcrypt (native build on Railway for no gain over scrypt).
