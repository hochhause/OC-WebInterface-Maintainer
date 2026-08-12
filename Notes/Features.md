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

### Discarded along the way

- Per-user accounts (user1/user2 on same network are indistinguishable — by design).
- `network_id` config value in connector's config.lua (the key is the identity).
- `/api/networks` endpoint (enumerated all tenants).
- Separate BROWSER_PASSWORD vs API_KEY for new installs (merged into one key;
  kept only for legacy `main`).
