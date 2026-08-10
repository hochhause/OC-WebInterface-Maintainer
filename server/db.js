import Database from 'better-sqlite3'

const db = new Database(process.env.DATA_DIR ? `${process.env.DATA_DIR}/data.db` : 'data.db')

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

`)

try { db.exec(`ALTER TABLE targets ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`) } catch {}

const q = {
  getTargets: db.prepare('SELECT * FROM targets WHERE network_id = ?'),
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
  getNetworks: db.prepare('SELECT DISTINCT network_id FROM stock'),
  upsertStock: db.prepare(`
    INSERT INTO stock (network_id, label, count) VALUES (?, ?, ?)
    ON CONFLICT(network_id, label) DO UPDATE SET count = excluded.count
  `),
  getSettings: db.prepare('SELECT maintainer_sleep FROM settings WHERE network_id = ?'),
  setSettings: db.prepare('INSERT INTO settings (network_id, maintainer_sleep) VALUES (?, ?) ON CONFLICT(network_id) DO UPDATE SET maintainer_sleep = excluded.maintainer_sleep')
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

export function getNetworks() {
  return q.getNetworks.all().map(r => r.network_id)
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

