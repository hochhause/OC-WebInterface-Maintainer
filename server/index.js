import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { randomBytes } from 'crypto'
import { WebSocketServer } from 'ws'
import {
  getTargets, upsertTarget, deleteTarget,
  getStock, updateStock,
  getSettings, setSettings,
  findNetworkByKey, getNetwork, createNetwork, touchNetwork, setNetworkKey, seedLegacyNetwork,
  createSession, getSessionNetwork, destroySession, sweepSessions,
  hashKey, DATA_DIR
} from './db.js'
import { getRegistry, REGISTRIES } from './registries.js'

// A "network" is one in-game OC instance. Its key is the only thing that
// identifies it: the connector authenticates with it, and a browser logs in
// with the same key. The site does not model individual humans -- everyone
// holding a network's key sees exactly that network and nothing else.
const MIN_KEY_LENGTH = 16
const SINGLE_USER = process.env.SINGLE_USER === 'true'
const OPEN_REGISTRATION = process.env.OPEN_REGISTRATION !== 'false'

seedLegacyNetwork()

// Local / single-player mode: exactly one network ("main"), no login from this
// machine, and whichever connector shows up owns it. This reproduces the
// zero-config experience the local setup always had. Loopback-only by design.
if (SINGLE_USER) {
  if (!getNetwork('main')) createNetwork({ id: 'main', name: 'main', key: randomBytes(32).toString('hex') })
  console.log('SINGLE_USER=true : browsers on this machine skip login and any connector key claims network "main".')
  console.log('                   Never set this on a host reachable from the internet.')
}

const app = express()
app.use(express.json({ limit: '1mb' }))
app.use(express.static('public'))

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

function parseCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, v] = part.trim().split('=')
    if (k === name) return v
  }
  return null
}

function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

// Resolves the network a browser request belongs to. Never reads it from the
// URL or body -- only from the session cookie -- so there is nothing to tamper with.
function networkFromRequest(req) {
  const fromSession = getSessionNetwork(parseCookie(req, 'session'))
  if (fromSession) return fromSession
  if (SINGLE_USER && isLoopback(req) && getNetwork('main')) return 'main'
  return null
}

function browserAuth(req, res, next) {
  const networkId = networkFromRequest(req)
  if (!networkId) return res.status(401).json({ error: 'unauthorized' })
  req.networkId = networkId
  next()
}

function bearerKey(req) {
  const header = req.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

// The connector's key both authenticates it and selects its network. A key that
// matches nothing provisions a new network, which is how an OC instance registers
// itself on first sync -- no signup flow needed.
function connectorAuth(req, res, next) {
  const key = bearerKey(req)
  if (!key) return res.status(401).json({ error: 'api key required' })

  if (SINGLE_USER) {
    const main = getNetwork('main')
    if (main.key_hash !== hashKey(key)) setNetworkKey('main', key)
    req.network = main
    req.networkId = 'main'
    return next()
  }

  let network = findNetworkByKey(key)
  if (!network) {
    if (!OPEN_REGISTRATION) {
      return res.status(401).json({ error: 'unknown api key' })
    } else if (key.length < MIN_KEY_LENGTH) {
      return res.status(401).json({ error: `api key must be at least ${MIN_KEY_LENGTH} characters` })
    } else {
      network = createNetwork({ name: req.body?.name, key })
      console.log(`new network ${network.id} ("${network.name}") registered`)
    }
  }
  req.network = network
  req.networkId = network.id
  next()
}

function withIcons(networkId, targets) {
  const { icons } = getRegistry(getNetwork(networkId)?.registry)
  return targets.map(t => ({ ...t, ...icons.get(t.label) }))
}

/* ---- rate limiting ---- */

const lastSync = new Map()
const lastStockStr = new Map()
const loginAttempts = new Map()

function syncRateLimit(req, res, next) {
  const now = Date.now()
  if (now - (lastSync.get(req.networkId) ?? 0) < 2000) return res.status(429).end()
  lastSync.set(req.networkId, now)
  next()
}

// Keys are high-entropy, but a public host still should not allow unlimited guessing.
function loginRateLimit(req, res, next) {
  const ip = req.socket.remoteAddress ?? 'unknown'
  const now = Date.now()
  const entry = loginAttempts.get(ip)
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 5 * 60_000 })
    return next()
  }
  if (entry.count >= 10) return res.status(429).json({ error: 'too many attempts, wait 5 minutes' })
  entry.count++
  next()
}

/* ---- websocket: authenticated on upgrade, scoped per network ---- */

wss.on('connection', (ws, req) => {
  const networkId = networkFromRequest(req)
  if (!networkId) return ws.close(4001, 'unauthorized')
  ws.networkId = networkId
  ws.on('error', console.error)
})

function broadcast(networkId, data) {
  const message = JSON.stringify(data)
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.networkId === networkId) client.send(message)
  }
}

function broadcastTargets(networkId) {
  broadcast(networkId, {
    type: 'targets',
    network_id: networkId,
    targets: withIcons(networkId, getTargets(networkId))
  })
}

/* ---- connector ---- */

app.post('/api/sync', connectorAuth, syncRateLimit, (req, res) => {
  const { stock, status, name } = req.body
  const networkId = req.networkId

  touchNetwork(networkId, typeof name === 'string' && name.trim() ? name.trim() : null)

  if (stock) {
    const str = JSON.stringify({ stock, status })
    if (str !== lastStockStr.get(networkId)) {
      lastStockStr.set(networkId, str)
      updateStock(networkId, stock)
      broadcast(networkId, { type: 'stock', network_id: networkId, stock, status })
    }
  }

  const ocTargets = getTargets(networkId)
    .filter(t => t.enabled !== 0)
    .map(t => ({
      label: t.label,
      threshold: t.threshold,
      batch_size: t.batch_size,
      fluid_tag: t.fluid_tag,
      is_fluid: t.is_fluid
    }))

  res.json({ targets: ocTargets, maintainer_sleep: getSettings(networkId).maintainer_sleep })
})

/* ---- session ---- */

app.post('/api/login', loginRateLimit, (req, res) => {
  const key = typeof req.body?.key === 'string' ? req.body.key.trim() : ''
  if (!key) return res.status(401).json({ error: 'key required' })

  let network = findNetworkByKey(key)

  // Legacy single-tenant installs logged in with BROWSER_PASSWORD rather than the
  // connector key. Keep that working for the seeded 'main' network.
  if (!network && process.env.BROWSER_PASSWORD && hashKey(key) === hashKey(process.env.BROWSER_PASSWORD)) {
    network = getNetwork('main')
  }

  if (!network) return res.status(401).json({ error: 'invalid key' })

  res.cookie('session', createSession(network.id), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    maxAge: 30 * 24 * 60 * 60 * 1000
  })
  res.json({ ok: true })
})

app.post('/api/logout', (req, res) => {
  destroySession(parseCookie(req, 'session'))
  res.clearCookie('session')
  res.json({ ok: true })
})

app.get('/api/me', browserAuth, (req, res) => {
  const network = getNetwork(req.networkId)
  const registry = getRegistry(network?.registry)
  res.json({
    id: network.id,
    name: network.name,
    last_sync_at: network.last_sync_at,
    registry: { id: registry.id, label: registry.label, url: `/registries/${registry.file}` }
  })
})

/* ---- targets ---- */

app.get('/api/targets', browserAuth, (req, res) => {
  res.json(withIcons(req.networkId, getTargets(req.networkId)))
})

function parseTarget(body) {
  const { label, threshold, batch_size, fluid_tag, is_fluid, enabled } = body
  const parsedThreshold = threshold === null || threshold === undefined || threshold === '' ? null : Number(threshold)
  const parsedBatch = Number(batch_size ?? 1)
  if (parsedThreshold !== null && !Number.isFinite(parsedThreshold)) return null
  if (!Number.isFinite(parsedBatch) || parsedBatch < 1) return null
  return {
    label,
    threshold: parsedThreshold,
    batch_size: Math.floor(parsedBatch),
    fluid_tag: fluid_tag ?? null,
    is_fluid: Boolean(is_fluid),
    enabled: enabled !== false
  }
}

app.post('/api/targets', browserAuth, (req, res) => {
  const { label } = req.body
  if (!label || typeof label !== 'string' || !label.trim()) {
    return res.status(400).json({ error: 'label required' })
  }
  const target = parseTarget(req.body)
  if (!target) return res.status(400).json({ error: 'invalid threshold or batch_size' })
  upsertTarget(req.networkId, target)
  broadcastTargets(req.networkId)
  res.json({ ok: true })
})

app.put('/api/targets/:label', browserAuth, (req, res) => {
  const target = parseTarget({ ...req.body, label: req.params.label })
  if (!target) return res.status(400).json({ error: 'invalid threshold or batch_size' })
  upsertTarget(req.networkId, target)
  broadcastTargets(req.networkId)
  res.json({ ok: true })
})

app.delete('/api/targets/:label', browserAuth, (req, res) => {
  deleteTarget(req.networkId, req.params.label)
  broadcastTargets(req.networkId)
  res.json({ ok: true })
})

/* ---- stock & settings ---- */

app.get('/api/stock', browserAuth, (req, res) => {
  res.json(getStock(req.networkId))
})

app.get('/api/settings', browserAuth, (req, res) => {
  res.json(getSettings(req.networkId))
})

app.put('/api/settings', browserAuth, (req, res) => {
  const sleep = Number(req.body.maintainer_sleep)
  if (!Number.isFinite(sleep) || sleep < 5) return res.status(400).json({ error: 'invalid' })
  setSettings(req.networkId, { maintainer_sleep: Math.floor(sleep) })
  res.json({ ok: true })
})

/* ---- housekeeping ---- */

setInterval(() => {
  sweepSessions()
  const cutoff = Date.now() - 60 * 60_000
  for (const [id, at] of lastSync) {
    if (at < cutoff) { lastSync.delete(id); lastStockStr.delete(id) }
  }
  for (const [ip, entry] of loginAttempts) {
    if (Date.now() > entry.resetAt) loginAttempts.delete(ip)
  }
}, 60 * 60_000).unref()

const port = process.env.PORT || 3000
server.listen(port, () => {
  console.log(`running on http://localhost:${port}`)
  console.log(`data dir: ${DATA_DIR}  |  registries: ${Object.keys(REGISTRIES).join(', ')}`)
})
