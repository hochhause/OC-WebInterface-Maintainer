import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { randomBytes } from 'crypto'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const dir = dirname(fileURLToPath(import.meta.url))
const itemRegistry = JSON.parse(readFileSync(resolve(dir, '../client/public/gtnh_registry.json'), 'utf8'))
const iconMap = new Map(itemRegistry.map(i => [i.label, { x: i.x, y: i.y }]))

function withIcons(targets) {
  return targets.map(t => ({ ...t, ...iconMap.get(t.label) }))
}
import {
  getTargets, upsertTarget, deleteTarget,
  getStock, getNetworks,
  updateStock,
  getSettings, setSettings
} from './db.js'

if (!process.env.BROWSER_PASSWORD) {
  console.log('WARNING : No BROWSER_PASSWORD in .env, anyone can access the page with link!')
}

const sessions = new Set()

function parseCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, v] = part.trim().split('=')
    if (k === name) return v
  }
  return null
}

function browserAuth(req, res, next) {
  if (!process.env.BROWSER_PASSWORD) return next()
  if (sessions.has(parseCookie(req, 'session'))) return next()
  res.status(401).end()
}

const app = express()
app.use(express.json())
app.use(express.static('public'))

const server = createServer(app)
const wss = new WebSocketServer({ server })

const lastSync = {}
const lastStockStr = {}

function rateLimit(req, res, next) {
  const id = req.body?.network_id
  if (!id) return next()
  const now = Date.now()
  if (lastSync[id] && now - lastSync[id] < 2000) {
    return res.status(429).end()
  }
  lastSync[id] = now
  next()
}

function auth(req, res, next) {
  const key = process.env.API_KEY
  if (!key) return next()
  if (req.headers.authorization !== `Bearer ${key}`) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  next()
}

function broadcast(data) {
  const message = JSON.stringify(data)
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(message)
  }
}

app.post('/api/sync', auth, rateLimit, (req, res) => {
  const { network_id, stock, status } = req.body
  if (!network_id) return res.status(400).json({ error: 'network_id required' })
  if (stock) {
    const str = JSON.stringify({ stock, status })
    if (str !== lastStockStr[network_id]) {
      lastStockStr[network_id] = str
      updateStock(network_id, stock)
      broadcast({ type: 'stock', network_id, stock, status })
    }
  }
  const settings = getSettings(network_id)
  const ocTargets = getTargets(network_id)
    .filter(t => t.enabled !== 0)
    .map(t => ({
      label: t.label,
      threshold: t.threshold,
      batch_size: t.batch_size,
      fluid_tag: t.fluid_tag,
      is_fluid: t.is_fluid
    }))
  res.json({ targets: ocTargets, maintainer_sleep: settings.maintainer_sleep })
})


app.post('/api/login', (req, res) => {
  if (req.body.password !== process.env.BROWSER_PASSWORD) return res.status(401).end()
  const token = randomBytes(16).toString('hex')
  sessions.add(token)
  res.cookie('session', token, { httpOnly: true })
  res.json({ ok: true })
})

app.get('/api/networks', browserAuth, (req, res) => {
  res.json(getNetworks())
})

app.get('/api/targets/:networkId', browserAuth, (req, res) => {
  res.json(withIcons(getTargets(req.params.networkId)))
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

app.post('/api/targets/:networkId', browserAuth, (req, res) => {
  const { label } = req.body
  if (!label || typeof label !== 'string' || !label.trim()) {
    return res.status(400).json({ error: 'label required' })
  }
  const target = parseTarget(req.body)
  if (!target) return res.status(400).json({ error: 'invalid threshold or batch_size' })
  upsertTarget(req.params.networkId, target)
  broadcast({ type: 'targets', network_id: req.params.networkId, targets: withIcons(getTargets(req.params.networkId)) })
  res.json({ ok: true })
})

app.put('/api/targets/:networkId/:label', browserAuth, (req, res) => {
  const target = parseTarget({ ...req.body, label: req.params.label })
  if (!target) return res.status(400).json({ error: 'invalid threshold or batch_size' })
  upsertTarget(req.params.networkId, target)
  broadcast({ type: 'targets', network_id: req.params.networkId, targets: withIcons(getTargets(req.params.networkId)) })
  res.json({ ok: true })
})

app.delete('/api/targets/:networkId/:label', browserAuth, (req, res) => {
  deleteTarget(req.params.networkId, req.params.label)
  broadcast({ type: 'targets', network_id: req.params.networkId, targets: withIcons(getTargets(req.params.networkId)) })
  res.json({ ok: true })
})

app.get('/api/stock/:networkId', browserAuth, (req, res) => {
  res.json(getStock(req.params.networkId))
})

app.get('/api/settings/:networkId', browserAuth, (req, res) => {
  res.json(getSettings(req.params.networkId))
})

app.put('/api/settings/:networkId', browserAuth, (req, res) => {
  const sleep = Number(req.body.maintainer_sleep)
  if (!Number.isFinite(sleep) || sleep < 5) return res.status(400).json({ error: 'invalid' })
  setSettings(req.params.networkId, { maintainer_sleep: Math.floor(sleep) })
  res.json({ ok: true })
})

wss.on('connection', (ws) => {
  ws.on('error', console.error)
})

const port = process.env.PORT || 3000
server.listen(port, () => console.log(`running on http://localhost:${port}`))
