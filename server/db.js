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
    maintainer_sleep INTEGER NOT NULL DEFAULT 10
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

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

const q = {
  getTargets: db.prepare('SELECT * FROM targets WHERE network_id = ? ORDER BY rowid ASC'),
  upsertTarget: db.prepare(`
    INSERT INTO targets (network_id, label, threshold, batch_size, fluid_tag, is_fluid, enabled)
    VALUES (@network_id, @label, @threshold, @batch_size, @fluid_tag, @is_fluid, @enabled)
    ON CONFLICT(network_id, label) DO UPDATE SET
      threshold = excluded.threshold,
      batch_size = excluded.batch_size,
      fluid_tag = excluded.fluid_tag,
      is_fluid = excluded.is_fluid,
      enabled = excluded.enabled
  `),
  deleteTarget: db.prepare('DELETE FROM targets WHERE network_id = ? AND label = ?'),
  getStock: db.prepare('SELECT * FROM stock WHERE network_id = ?'),
  upsertStock: db.prepare(`
    INSERT INTO stock (network_id, label, count) VALUES (?, ?, ?)
    ON CONFLICT(network_id, label) DO UPDATE SET count = excluded.count
  `),
  getSettings: db.prepare('SELECT maintainer_sleep FROM settings WHERE network_id = ?'),
  setSettings: db.prepare('INSERT INTO settings (network_id, maintainer_sleep) VALUES (?, ?) ON CONFLICT(network_id) DO UPDATE SET maintainer_sleep = excluded.maintainer_sleep'),

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
  q.deleteTarget.run(networkId, label)
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
  return q.getSettings.get(networkId) ?? { maintainer_sleep: 10 }
}

export function setSettings(networkId, settings) {
  q.setSettings.run(networkId, settings.maintainer_sleep)
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
