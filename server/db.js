import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { createHash, randomBytes } from 'crypto'
import { DEFAULT_REGISTRY } from './registries.js'

// Persistent storage lives on a mounted volume in every hosted setup.
// DATA_DIR wins; Railway injects RAILWAY_VOLUME_MOUNT_PATH for its volumes.
export const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || '.'
mkdirSync(DATA_DIR, { recursive: true })

const db = new Database(`${DATA_DIR}/data.db`)
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')

db.exec(`
  CREATE TABLE IF NOT EXISTS targets (
    network_id TEXT NOT NULL,
    label TEXT NOT NULL,
    threshold INTEGER,
    batch_size INTEGER NOT NULL DEFAULT 1,
    fluid_tag TEXT,
    is_fluid INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    group_id INTEGER,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (network_id, label)
  );

  CREATE TABLE IF NOT EXISTS stock (
    network_id TEXT NOT NULL,
    label TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (network_id, label)
  );

  CREATE TABLE IF NOT EXISTS settings (
    network_id TEXT PRIMARY KEY,
    maintainer_sleep INTEGER NOT NULL DEFAULT 10,
    cpu_limit INTEGER NOT NULL DEFAULT 0,
    default_run_seq INTEGER NOT NULL DEFAULT 0
  );

  -- Groups were browser-local (localStorage) until the maintainer needed to know
  -- about them to run per-group schedules. Membership lives on targets.group_id;
  -- row order lives on targets.position -- one source of truth for each.
  CREATE TABLE IF NOT EXISTS groups (
    network_id TEXT NOT NULL,
    id INTEGER NOT NULL,
    name TEXT NOT NULL,
    collapsed INTEGER NOT NULL DEFAULT 0,
    interval_s INTEGER,
    min_tps REAL,
    run_seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (network_id, id)
  );

  CREATE TABLE IF NOT EXISTS networks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    registry TEXT NOT NULL DEFAULT '${DEFAULT_REGISTRY}',
    created_at INTEGER NOT NULL,
    last_sync_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    network_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`)

try { db.exec(`ALTER TABLE targets ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`) } catch {}
try { db.exec(`ALTER TABLE targets ADD COLUMN group_id INTEGER`) } catch {}
try { db.exec(`ALTER TABLE targets ADD COLUMN position INTEGER NOT NULL DEFAULT 0`) } catch {}
try { db.exec(`ALTER TABLE settings ADD COLUMN cpu_limit INTEGER NOT NULL DEFAULT 0`) } catch {}
try { db.exec(`ALTER TABLE settings ADD COLUMN default_run_seq INTEGER NOT NULL DEFAULT 0`) } catch {}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

const q = {
  // position is 0 for every row until the user drags something, so rowid keeps
  // ordering pre-existing networks exactly as they were ordered before.
  getTargets: db.prepare('SELECT * FROM targets WHERE network_id = ? ORDER BY position ASC, rowid ASC'),
  upsertTarget: db.prepare(`
    INSERT INTO targets (network_id, label, threshold, batch_size, fluid_tag, is_fluid, enabled, position)
    VALUES (@network_id, @label, @threshold, @batch_size, @fluid_tag, @is_fluid, @enabled,
      (SELECT COALESCE(MAX(position), 0) + 1 FROM targets WHERE network_id = @network_id))
    ON CONFLICT(network_id, label) DO UPDATE SET
      threshold = excluded.threshold,
      batch_size = excluded.batch_size,
      fluid_tag = excluded.fluid_tag,
      is_fluid = excluded.is_fluid,
      enabled = excluded.enabled
  `),
  deleteTarget: db.prepare('DELETE FROM targets WHERE network_id = ? AND label = ?'),
  setPosition: db.prepare('UPDATE targets SET position = ? WHERE network_id = ? AND label = ?'),
  parkUnordered: db.prepare(`
    UPDATE targets SET position = (SELECT COALESCE(MAX(position), 0) + 1 FROM targets WHERE network_id = ?)
    WHERE network_id = ? AND position = 0
  `),

  getGroups: db.prepare('SELECT * FROM groups WHERE network_id = ? ORDER BY id ASC'),
  getGroup: db.prepare('SELECT * FROM groups WHERE network_id = ? AND id = ?'),
  upsertGroup: db.prepare(`
    INSERT INTO groups (network_id, id, name, collapsed, interval_s, min_tps, run_seq)
    VALUES (@network_id, @id, @name, @collapsed, @interval_s, @min_tps, 0)
    ON CONFLICT(network_id, id) DO UPDATE SET
      name = excluded.name,
      collapsed = excluded.collapsed,
      interval_s = excluded.interval_s,
      min_tps = excluded.min_tps
  `),
  deleteGroup: db.prepare('DELETE FROM groups WHERE network_id = ? AND id = ?'),
  bumpGroupSeq: db.prepare('UPDATE groups SET run_seq = run_seq + 1 WHERE network_id = ? AND id = ?'),
  clearMembership: db.prepare('UPDATE targets SET group_id = NULL WHERE network_id = ?'),
  setMembership: db.prepare('UPDATE targets SET group_id = ? WHERE network_id = ? AND label = ?'),
  // A group of one is what the table draws no bracket for, so it must not linger
  // with a live schedule attached either.
  dropThinGroups: db.prepare(`
    DELETE FROM groups WHERE network_id = ? AND id NOT IN (
      SELECT group_id FROM targets WHERE network_id = ? AND group_id IS NOT NULL
      GROUP BY group_id HAVING COUNT(*) >= 2
    )
  `),
  clearOrphanMembership: db.prepare(`
    UPDATE targets SET group_id = NULL WHERE network_id = ? AND group_id IS NOT NULL
      AND group_id NOT IN (SELECT id FROM groups WHERE network_id = ?)
  `),
  getStock: db.prepare('SELECT * FROM stock WHERE network_id = ?'),
  upsertStock: db.prepare(`
    INSERT INTO stock (network_id, label, count) VALUES (?, ?, ?)
    ON CONFLICT(network_id, label) DO UPDATE SET count = excluded.count
  `),
  getSettings: db.prepare('SELECT maintainer_sleep, cpu_limit, default_run_seq FROM settings WHERE network_id = ?'),
  setSettings: db.prepare(`
    INSERT INTO settings (network_id, maintainer_sleep, cpu_limit) VALUES (?, ?, ?)
    ON CONFLICT(network_id) DO UPDATE SET
      maintainer_sleep = excluded.maintainer_sleep,
      cpu_limit = excluded.cpu_limit
  `),
  bumpDefaultSeq: db.prepare(`
    INSERT INTO settings (network_id, maintainer_sleep, cpu_limit, default_run_seq) VALUES (?, 10, 0, 1)
    ON CONFLICT(network_id) DO UPDATE SET default_run_seq = default_run_seq + 1
  `),

  networkByHash: db.prepare('SELECT * FROM networks WHERE key_hash = ?'),
  networkById: db.prepare('SELECT * FROM networks WHERE id = ?'),
  insertNetwork: db.prepare('INSERT INTO networks (id, name, key_hash, registry, created_at) VALUES (?, ?, ?, ?, ?)'),
  updateNetworkKey: db.prepare('UPDATE networks SET key_hash = ? WHERE id = ?'),
  touchNetwork: db.prepare('UPDATE networks SET last_sync_at = ?, name = COALESCE(?, name) WHERE id = ?'),

  insertSession: db.prepare('INSERT INTO sessions (token, network_id, expires_at) VALUES (?, ?, ?)'),
  getSession: db.prepare('SELECT network_id FROM sessions WHERE token = ? AND expires_at > ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  sweepSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?')
}

export function hashKey(key) {
  return createHash('sha256').update(String(key), 'utf8').digest('hex')
}

export function getTargets(networkId) {
  return q.getTargets.all(networkId)
}

export function upsertTarget(networkId, target) {
  q.upsertTarget.run({
    network_id: networkId,
    label: target.label,
    threshold: target.threshold ?? null,
    batch_size: target.batch_size ?? 1,
    fluid_tag: target.fluid_tag ?? null,
    is_fluid: target.is_fluid ? 1 : 0,
    enabled: target.enabled === false ? 0 : 1
  })
}

export function deleteTarget(networkId, label) {
  db.transaction(() => {
    q.deleteTarget.run(networkId, label)
    pruneGroups(networkId)
  })()
}

/* ---- groups: schedule units the maintainer runs, drawn as brackets on the web ---- */

export function getGroups(networkId) {
  return q.getGroups.all(networkId)
}

function intOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Math.floor(Number(v))
  return Number.isFinite(n) ? n : null
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Groups with fewer than two members are dropped, and members pointing at a
// group that no longer exists are released. Called after every membership change.
function pruneGroups(networkId) {
  q.dropThinGroups.run(networkId, networkId)
  q.clearOrphanMembership.run(networkId, networkId)
}

/**
 * Replaces the whole group layout in one shot. The table's bracket editor thinks
 * in terms of "here is the new set of groups", and last-write-wins on the entire
 * layout is what two browsers editing at once did before this moved server-side.
 *
 * Fields the caller leaves out keep their stored value, so redrawing brackets
 * cannot silently wipe a schedule somebody set from the schedules panel. run_seq
 * survives for every group that keeps its id.
 */
export function replaceGroups(networkId, incoming) {
  db.transaction(() => {
    const keep = new Set()
    for (const g of incoming) {
      const id = intOrNull(g.id)
      if (id === null || id <= 0) continue
      keep.add(id)
      const current = q.getGroup.get(networkId, id)
      q.upsertGroup.run({
        network_id: networkId,
        id,
        name: String(g.name ?? '').trim().slice(0, 64) || current?.name || `Group ${id}`,
        collapsed: 'collapsed' in g ? (g.collapsed ? 1 : 0) : (current?.collapsed ?? 0),
        interval_s: 'interval_s' in g ? intOrNull(g.interval_s) : (current?.interval_s ?? null),
        min_tps: 'min_tps' in g ? numOrNull(g.min_tps) : (current?.min_tps ?? null)
      })
    }
    for (const row of q.getGroups.all(networkId)) {
      if (!keep.has(row.id)) q.deleteGroup.run(networkId, row.id)
    }
    q.clearMembership.run(networkId)
    for (const g of incoming) {
      const id = intOrNull(g.id)
      if (id === null || !keep.has(id)) continue
      for (const label of g.labels ?? []) q.setMembership.run(id, networkId, label)
    }
    pruneGroups(networkId)
  })()
}

export function updateGroup(networkId, id, patch) {
  const current = q.getGroup.get(networkId, id)
  if (!current) return false
  q.upsertGroup.run({
    network_id: networkId,
    id,
    name: 'name' in patch ? (String(patch.name ?? '').trim().slice(0, 64) || current.name) : current.name,
    collapsed: 'collapsed' in patch ? (patch.collapsed ? 1 : 0) : current.collapsed,
    interval_s: 'interval_s' in patch ? intOrNull(patch.interval_s) : current.interval_s,
    min_tps: 'min_tps' in patch ? numOrNull(patch.min_tps) : current.min_tps
  })
  return true
}

export function deleteGroup(networkId, id) {
  db.transaction(() => {
    q.deleteGroup.run(networkId, id)
    pruneGroups(networkId)
  })()
}

/* ---- run-now: a counter the maintainer watches, not a command it must catch ---- */

export function bumpRunSeq(networkId, groupId) {
  if (groupId === null || groupId === undefined) {
    q.bumpDefaultSeq.run(networkId)
    return true
  }
  return q.bumpGroupSeq.run(networkId, groupId).changes > 0
}

/* ---- row order (was per-browser localStorage) ---- */

export function setTargetOrder(networkId, labels) {
  db.transaction(() => {
    labels.forEach((label, i) => q.setPosition.run(i + 1, networkId, label))
    // Anything the caller did not mention keeps its rowid tiebreak behind the
    // ordered rows instead of jumping to the front on position 0.
    q.parkUnordered.run(networkId, networkId)
  })()
}

export function getStock(networkId) {
  return q.getStock.all(networkId)
}

export function updateStock(networkId, stock) {
  db.transaction(() => {
    for (const [label, count] of Object.entries(stock)) {
      q.upsertStock.run(networkId, label, count)
    }
  })()
}

export function getSettings(networkId) {
  return q.getSettings.get(networkId) ?? { maintainer_sleep: 10, cpu_limit: 0, default_run_seq: 0 }
}

export function setSettings(networkId, patch) {
  const next = { ...getSettings(networkId), ...patch }
  q.setSettings.run(networkId, next.maintainer_sleep, next.cpu_limit)
}

/* ---- networks: one per in-game OC instance, identified solely by its key ---- */

export function findNetworkByKey(key) {
  return q.networkByHash.get(hashKey(key)) ?? null
}

export function getNetwork(id) {
  return q.networkById.get(id) ?? null
}

export function createNetwork({ name, key, registry = DEFAULT_REGISTRY, id }) {
  const networkId = id || 'n_' + randomBytes(6).toString('hex')
  q.insertNetwork.run(networkId, name || 'unnamed', hashKey(key), registry, Date.now())
  return getNetwork(networkId)
}

export function touchNetwork(id, name) {
  q.touchNetwork.run(Date.now(), name || null, id)
}

export function setNetworkKey(id, key) {
  q.updateNetworkKey.run(hashKey(key), id)
}

/**
 * Legacy single-tenant installs kept their credentials in .env and all their rows
 * under network_id 'main'. Mirror those env vars onto a real network row on every
 * boot so existing databases keep working and .env stays the source of truth.
 */
export function seedLegacyNetwork() {
  const key = process.env.API_KEY
  if (!key) return null
  const existing = getNetwork('main')
  try {
    if (existing) {
      if (existing.key_hash !== hashKey(key)) q.updateNetworkKey.run(hashKey(key), 'main')
    } else {
      q.insertNetwork.run('main', 'main', hashKey(key), DEFAULT_REGISTRY, Date.now())
    }
  } catch (err) {
    console.error('could not seed legacy network "main":', err.message)
  }
  return getNetwork('main')
}

/* ---- sessions ---- */

export function createSession(networkId) {
  const token = randomBytes(32).toString('hex')
  q.insertSession.run(token, networkId, Date.now() + SESSION_TTL_MS)
  return token
}

export function getSessionNetwork(token) {
  if (!token) return null
  return q.getSession.get(token, Date.now())?.network_id ?? null
}

export function destroySession(token) {
  if (token) q.deleteSession.run(token)
}

export function sweepSessions() {
  q.sweepSessions.run(Date.now())
}
