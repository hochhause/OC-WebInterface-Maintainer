const app = document.getElementById('app')

const msg = {
  addFailed: 'Failed to add target: server unreachable.',
  deleteFailed: 'Failed to delete target: server unreachable.',
  saveFailed: 'Failed to save target: server unreachable or invalid value.',
  groupFailed: 'Failed to save groups: server unreachable.',
  orderFailed: 'Failed to save order: server unreachable.',
  serverDown: 'Failed to connect to server. Is it running?',
  loginFailed: 'Wrong key. Use the key from your Connector computer\'s config.lua.'
}

let networkId = null
let network = null
let targets = []
let groups = []
let stock = {}
let registry = []
let itemStatus = {}
const timers = {}
let sleepTimer = null
let cpuTimer = null
let maintainerSleep = 10
let cpuLimit = 0
let pendingAdds = []
let addDefaults = { threshold: null, batch_size: 1, enabled: true, group_id: null }
let isDirty = false
let currentSort = localStorage.getItem('maintainer_sort_mode') || 'default'
// Schedules are set-and-forget, and a network with a dozen groups would other-
// wise spend half the page on rows that say "on the default schedule".
let schedulesOpen = localStorage.getItem('maintainer_schedules_open') === 'true'
let isDragging = false
// Run-now is a counter the maintainer picks up on its next poll, so the button
// stays in a "queued" state until a status arrives that was measured after the click.
const pendingRun = {}

// Row order is server-side now, so 'default' renders exactly the saved order --
// 'custom' is the same order plus the drag and bracket gestures.
const ORDERED_MODES = ['default', 'custom']

function formatShort(n) {
  if (n === null || n === undefined || n === '') return ''
  const num = Number(n)
  if (!Number.isFinite(num)) return ''
  if (num >= 1e15) return (num / 1e15).toFixed(1).replace(/\.0$/, '') + 'q'
  if (num >= 1e12) return (num / 1e12).toFixed(1).replace(/\.0$/, '') + 't'
  if (num >= 1e9) return (num / 1e9).toFixed(1).replace(/\.0$/, '') + 'b'
  if (num >= 1e6) return (num / 1e6).toFixed(1).replace(/\.0$/, '') + 'm'
  if (num >= 1e3) return (num / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(num)
}

function formatCount(n) {
  return formatShort(n)
}

function parseAmount(str) {
  if (!str || str.trim() === '') return null
  const multipliers = { k: 1e3, m: 1e6, b: 1e9, g: 1e9, t: 1e12, q: 1e15 }
  const s = str.toLowerCase().trim().replace(/,/g, '').replace(/(\d+\.?\d*)([kmbtqg]+)/g, (_, num, suf) => {
    let val = parseFloat(num)
    for (const c of suf) val *= multipliers[c] || 1
    return String(val)
  })
  if (!/^[\d\s+\-*/.()e]+$/.test(s)) return null
  try {
    const result = Function('"use strict"; return (' + s + ')')()
    return Number.isFinite(result) ? Math.round(result) : null
  } catch { return null }
}

// Group names and the network name are typed by people, and with one key shared
// between players "people" is not only you. Item labels come from the registry.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, c => HTML_ESCAPES[c])
}

function iconStyle(x, y) {
  if (x === undefined || y === undefined) return ''
  return `background-position: -${x}px -${y}px`
}

function iconHtml(x, y) {
  if (x === undefined || y === undefined) return '<span class="gtnh-icon gtnh-icon-missing"></span>'
  return `<span class="gtnh-icon" style="${iconStyle(x, y)}"></span>`
}

function showToast(message, type = 'success', action = null) {
  let container = document.getElementById('toast-container')
  if (!container) {
    container = document.createElement('div')
    container.id = 'toast-container'
    container.className = 'toast-container'
    document.body.appendChild(container)
  }
  const toast = document.createElement('div')
  toast.className = `toast toast-${type}`
  
  const textNode = document.createElement('span')
  textNode.textContent = message
  toast.appendChild(textNode)

  if (action && action.text && action.callback) {
    const btn = document.createElement('button')
    btn.textContent = action.text
    btn.style.marginLeft = '8px'
    btn.style.background = 'none'
    btn.style.border = 'none'
    btn.style.color = type === 'error' ? '#ffaaaa' : '#55ff55'
    btn.style.textDecoration = 'underline'
    btn.style.cursor = 'pointer'
    btn.style.fontWeight = 'bold'
    btn.style.padding = '0'
    btn.onclick = (e) => {
      e.stopPropagation()
      action.callback()
      toast.classList.remove('show')
      setTimeout(() => toast.remove(), 200)
    }
    toast.appendChild(btn)
  }

  container.appendChild(toast)
  setTimeout(() => toast.classList.add('show'), 10)
  setTimeout(() => {
    if (toast.parentNode) {
      toast.classList.remove('show')
      setTimeout(() => toast.remove(), 200)
    }
  }, 5000)
}

// The server derives our network from the session cookie, so no id is ever
// sent in a URL -- /api/me is how we learn which one we are looking at.
async function fetchMe() {
  const res = await fetch('/api/me')
  if (res.status === 401) return null
  return res.json()
}

async function fetchTargets() {
  const res = await fetch('/api/targets')
  targets = await res.json()
}

async function fetchGroups() {
  const res = await fetch('/api/groups')
  groups = await res.json()
}

async function fetchStock() {
  const res = await fetch('/api/stock')
  const rows = await res.json()
  stock = Object.fromEntries(rows.map(r => [r.label, r.count]))
}

// What the maintainer last said about itself: per-item state, TPS, CPU counts and
// how long ago each schedule ran. Without this a reload shows nothing until the
// next connector poll lands.
async function fetchStatus() {
  const res = await fetch('/api/status')
  itemStatus = await res.json()
}

async function fetchRegistry() {
  const res = await fetch(network.registry.url)
  registry = await res.json()
}

async function fetchSettings() {
  const res = await fetch('/api/settings')
  const data = await res.json()
  maintainerSleep = data.maintainer_sleep ?? 10
  cpuLimit = data.cpu_limit ?? 0
}

function showLogin() {
  app.innerHTML = `
    <div class="login-panel">
      <h1>OC Level Maintainer</h1>
      <p class="login-hint">
        Enter your network key &mdash; the <code>api_key</code> from your Connector
        computer's <code>config.lua</code>. It decides which AE2 network you see.
      </p>
      <p id="login-error" class="login-error"></p>
      <input id="login-key" type="password" placeholder="Network key" autocomplete="current-password">
      <button id="login-btn">Connect</button>
    </div>
  `
  const keyInput = document.getElementById('login-key')
  const submit = async () => {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: keyInput.value.trim() })
    })
    if (res.ok) {
      init()
    } else {
      const body = await res.json().catch(() => ({}))
      document.getElementById('login-error').textContent = body.error === 'too many attempts, wait 5 minutes'
        ? 'Too many attempts. Wait 5 minutes.'
        : msg.loginFailed
    }
  }
  document.getElementById('login-btn').onclick = submit
  keyInput.onkeydown = e => { if (e.key === 'Enter') submit() }
  keyInput.focus()
}

async function saveTarget(label, data) {
  try {
    const res = await fetch(`/api/targets/${encodeURIComponent(label)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
    if (!res.ok) throw new Error()
    isDirty = true
  } catch {
    showToast(msg.saveFailed, 'error')
    throw new Error(msg.saveFailed)
  }
}

// One request for the whole selection: a picker run of twenty items would
// otherwise be twenty POSTs, which the rate limiter would cut off halfway.
async function addTargets(items, threshold, batchSize, enabled, groupId) {
  let parsedThreshold = threshold === '' ? null : (parseAmount(threshold) ?? Number(threshold))
  if (parsedThreshold !== null && parsedThreshold > 9000000000000000) parsedThreshold = 9000000000000000
  let parsedBatch = parseAmount(batchSize) ?? Number(batchSize) ?? 1
  if (parsedBatch > 9000000000000000) parsedBatch = 9000000000000000

  try {
    const res = await fetch('/api/targets/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group_id: groupId ?? null,
        targets: items.map(item => ({
          label: item.label,
          threshold: parsedThreshold,
          batch_size: parsedBatch,
          is_fluid: item.is_fluid,
          enabled
        }))
      })
    })
    if (!res.ok) throw new Error()
    isDirty = true
    await Promise.all([fetchTargets(), fetchGroups()])
    pendingAdds = []
    render()
    if (items.length > 1) showToast(`Added ${items.length} items.`, 'success')
  } catch {
    showToast(msg.addFailed, 'error')
  }
}

async function removeTarget(label) {
  clearTimeout(timers[label])
  delete timers[label]
  try {
    const res = await fetch(`/api/targets/${encodeURIComponent(label)}`, { method: 'DELETE' })
    if (!res.ok) throw new Error()
    isDirty = true
    await fetchTargets()
    render()
  } catch {
    showToast(msg.deleteFailed, 'error')
  }
}

async function changeTargetItem(oldLabel, newLabel, newIsFluid) {
  const old = targets.find(t => t.label === oldLabel)
  try {
    const res1 = await fetch(`/api/targets/${encodeURIComponent(oldLabel)}`, { method: 'DELETE' })
    if (!res1.ok) throw new Error()
    const res2 = await fetch('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: newLabel,
        threshold: old?.threshold ?? null,
        batch_size: old?.batch_size ?? 1,
        is_fluid: newIsFluid,
        enabled: old?.enabled !== 0,
        // Swapping the item on a grouped row used to drop it out of its group,
        // because a swap is a delete plus an add.
        group_id: old?.group_id ?? null
      })
    })
    if (!res2.ok) throw new Error()
    isDirty = true
    await Promise.all([fetchTargets(), fetchGroups()])
    render()
  } catch {
    showToast(msg.saveFailed, 'error')
  }
}


/**
 * Item picker. onSelect gets an array -- one entry for a plain click, or every
 * shift-clicked item when picking a run of them. multi:false keeps the old
 * single-shot behaviour for swapping the item on an existing row.
 */
function openItemPicker(onSelect, { multi = true } = {}) {
  const overlay = document.createElement('div')
  overlay.className = 'picker-overlay'
  overlay.innerHTML = `
    <div class="picker-modal">
      <div class="picker-header">
        <input id="picker-search" type="text" placeholder="Search items..." autocomplete="off">
        <button id="picker-close">X</button>
      </div>
      <div id="picker-grid" class="picker-grid"></div>
      ${multi ? `
        <div class="picker-footer">
          <span class="picker-hint">Shift-click to pick several</span>
          <span id="picker-count" class="picker-count"></span>
          <button id="picker-done" disabled>Add selected</button>
        </div>` : ''}
    </div>
  `
  document.body.appendChild(overlay)

  const searchInput = overlay.querySelector('#picker-search')
  const grid = overlay.querySelector('#picker-grid')
  const selected = new Map()

  function updateFooter() {
    const count = overlay.querySelector('#picker-count')
    const done = overlay.querySelector('#picker-done')
    if (!count || !done) return
    count.textContent = selected.size ? `${selected.size} selected` : ''
    done.disabled = selected.size === 0
    done.textContent = selected.size > 1 ? `Add ${selected.size} items` : 'Add selected'
  }

  function renderResults(items) {
    grid.innerHTML = items.slice(0, 64).map(i => `
      <div class="picker-item ${selected.has(i.label) ? 'picker-item-selected' : ''}"
           data-label="${i.label}" data-fluid="${i.is_fluid}" title="${i.label}">
        ${iconHtml(i.x, i.y)}
        <span class="picker-item-name">${i.label}</span>
      </div>
    `).join('')

    grid.querySelectorAll('.picker-item').forEach(el => {
      el.onclick = (e) => {
        const item = { label: el.dataset.label, is_fluid: el.dataset.fluid === 'true' }
        if (multi && (e.shiftKey || selected.size > 0)) {
          // Once a selection exists, plain clicks keep adding to it -- holding
          // shift for every item of a long run is tedious.
          if (selected.has(item.label)) selected.delete(item.label)
          else selected.set(item.label, item)
          el.classList.toggle('picker-item-selected', selected.has(item.label))
          updateFooter()
          return
        }
        onSelect([item])
        overlay.remove()
      }
    })
  }

  function search(q) {
    if (!q) { renderResults([]); return }
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean)
    renderResults(registry.filter(i => {
      const label = i.label.toLowerCase()
      return tokens.every(t => label.includes(t))
    }))
  }

  search('')
  searchInput.addEventListener('input', () => search(searchInput.value.trim()))

  const done = overlay.querySelector('#picker-done')
  if (done) {
    done.onclick = () => {
      onSelect([...selected.values()])
      overlay.remove()
    }
  }
  // Enter commits the selection so a search-shift-click-search run never needs the mouse.
  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && selected.size) {
      onSelect([...selected.values()])
      overlay.remove()
    }
  })

  overlay.querySelector('#picker-close').onclick = () => overlay.remove()
  overlay.onclick = e => { if (e.target === overlay) overlay.remove() }
  searchInput.focus()
}

function connectWs() {
  if (document.hidden || !networkId) return
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/ws`)

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.network_id !== networkId) return

    if (msg.type === 'stock') {
      Object.assign(stock, msg.stock)
      if (msg.status) itemStatus = msg.status
      reconcilePendingRuns()
      if (!isDragging) updateStockCells()
      if (isDirty) {
        isDirty = false
        showToast('Synced to OC!', 'success')
      }
    }
    if (msg.type === 'targets') {
      targets = msg.targets
      Object.keys(timers).forEach(k => { clearTimeout(timers[k]); delete timers[k] })
      if (!isDragging) render()
    }
    if (msg.type === 'groups') {
      groups = msg.groups
      if (!isDragging) renderTable()
    }
  }

  // 4001 = server rejected the session; retrying would spin forever.
  ws.onclose = (e) => {
    if (e.code === 4001) { networkId = null; network = null; showLogin(); return }
    if (!document.hidden) setTimeout(connectWs, 3000)
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) connectWs()
})

function updateStatusCounts() {
  const el = document.getElementById('status-counts')
  if (!el) return
  const enabled = targets.filter(t => t.enabled !== 0)
  const disabled = targets.length - enabled.length
  const failed = enabled.filter(t => itemStatus.failed?.[t.label]).length
  const crafting = enabled.filter(t => itemStatus.crafting?.[t.label] && !itemStatus.failed?.[t.label]).length
  const waiting = enabled.filter(t =>
    itemStatus.waiting_cpu?.[t.label] && !itemStatus.failed?.[t.label] && !itemStatus.crafting?.[t.label]).length
  const stocked = enabled.filter(t => {
    if (itemStatus.failed?.[t.label] || itemStatus.crafting?.[t.label] || itemStatus.waiting_cpu?.[t.label]) return false
    const count = stock[t.label]
    return t.threshold === null || (count !== undefined && count >= t.threshold)
  }).length
  el.innerHTML = `
    <span class="count-stocked">${stocked} stocked</span>
    <span class="count-crafting">${crafting} crafting</span>
    ${waiting ? `<span class="count-waiting">${waiting} waiting for CPU</span>` : ''}
    <span class="count-failed">${failed} failed</span>
    <span class="count-disabled">${disabled} disabled</span>
  `
}

// Numbers the maintainer measures in-game: TPS (against the server's real clock)
// and how many crafting CPUs are busy.
function updateLiveMeta() {
  const el = document.getElementById('live-meta')
  if (!el) return
  const parts = []
  if (typeof itemStatus.tps === 'number') {
    const cls = itemStatus.tps >= 19 ? 'tps-good' : itemStatus.tps >= 15 ? 'tps-slow' : 'tps-bad'
    parts.push(`<span class="${cls}" title="Server ticks per second, measured in-game">${itemStatus.tps.toFixed(1)} TPS</span>`)
  }
  if (itemStatus.cpus && typeof itemStatus.cpus.total === 'number') {
    parts.push(`<span title="Crafting CPUs busy / total">${itemStatus.cpus.busy ?? 0}/${itemStatus.cpus.total} CPUs</span>`)
  }
  el.innerHTML = parts.join(' &middot; ')
}

function updateStockCells() {
  updateStatusCounts()
  updateLiveMeta()
  renderSchedulePanel()
  for (const t of targets) {
    const cell = document.getElementById(`stock-${t.label}`)
    if (cell) {
      const count = stock[t.label]
      cell.textContent = count === undefined ? '...' : formatCount(count)
      cell.title = count === undefined ? 'Loading...' : String(count)
    }
    const row = document.querySelector(`tr[data-row="${CSS.escape(t.label)}"]`)
    if (row) {
      const keep = ['group-first', 'group-middle', 'group-last', 'row-disabled'].filter(c => row.classList.contains(c))
      row.className = [rowStatusClass(t.label, t), ...keep].filter(Boolean).join(' ')
    }
  }
}

function render() {
  app.innerHTML = `
    <div class="page-header">
      <div class="title-container">
        <h1>OC Level Maintainer</h1>
        <span class="author-credits">
          by Soycake
          <a href="https://github.com/Soycakes/OC-WebInterface-Maintainer" target="_blank" rel="noopener noreferrer">
            <img src="/githubLogo.png" alt="GitHub" class="credit-logo gh-logo" />
          </a>
          <a href="https://www.youtube.com/@soycake" target="_blank" rel="noopener noreferrer">
            <img src="/youtubeLogo.png" alt="YouTube" class="credit-logo" />
          </a>
        </span>
      </div>
    </div>
    <div id="network-bar"></div>
    <div class="table-toolbar">
      <div id="status-counts" class="status-counts"></div>
      <div class="toolbar-right">
        <div class="sort-container">
          <label for="sort-select">Sort by:</label>
          <select id="sort-select">
            <option value="default">Default</option>
            <option value="az">Alphabetical A-Z</option>
            <option value="za">Alphabetical Z-A</option>
            <option value="threshold-lh">Threshold (Low to High)</option>
            <option value="threshold-hl">Threshold (High to Low)</option>
            <option value="custom">Custom (Drag & Drop)</option>
          </select>
        </div>
        <label class="sleep-setting">Check every <input id="sleep-input" type="number" min="5" value="${maintainerSleep}"> s</label>
        <label class="sleep-setting" title="0 = only the free-CPU floor. 3 = never run more than 3 of our own jobs at once. -2 = always leave 2 CPUs free for players.">CPU limit <input id="cpu-input" type="number" value="${cpuLimit}"></label>
      </div>
    </div>
    <div id="main-content">
      <div id="table-container"></div>
    </div>
    <div id="add-container" class="mc-inventory-panel"></div>
    <div id="schedule-container" class="mc-inventory-panel"></div>
  `

  document.getElementById('sleep-input').addEventListener('input', (e) => {
    const val = Math.max(1, Math.floor(Number(e.target.value)))
    if (!val) return
    clearTimeout(sleepTimer)
    sleepTimer = setTimeout(async () => {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maintainer_sleep: val })
      })
      maintainerSleep = val
      renderSchedulePanel()
    }, 2000)
  })

  document.getElementById('cpu-input').addEventListener('input', (e) => {
    const raw = e.target.value.trim()
    if (raw === '' || raw === '-') return
    const val = Math.trunc(Number(raw))
    if (!Number.isFinite(val) || Math.abs(val) > 1024) return
    clearTimeout(cpuTimer)
    cpuTimer = setTimeout(async () => {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cpu_limit: val })
      })
      if (res.ok) cpuLimit = val
      else showToast('Failed to save the CPU limit.', 'error')
    }, 1000)
  })

  const sortSelect = document.getElementById('sort-select')
  sortSelect.value = currentSort
  sortSelect.addEventListener('change', (e) => {
    currentSort = e.target.value
    localStorage.setItem('maintainer_sort_mode', currentSort)
    renderTable()
  })

  renderNetworkBar()
  renderTable()
}

function formatLastSync(ts) {
  if (!ts) return 'never synced'
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (secs < 60) return `synced ${secs}s ago`
  if (secs < 3600) return `synced ${Math.round(secs / 60)}m ago`
  return `synced ${Math.round(secs / 3600)}h ago`
}

// One key == one OC instance, so there is nothing to switch between here.
// The bar just confirms which network the key unlocked.
function renderNetworkBar() {
  const bar = document.getElementById('network-bar')
  if (!bar || !network) return

  bar.innerHTML = `
    <span class="network-name">${escapeHtml(network.name)}</span>
    <span class="network-meta">${network.registry.label} &middot; ${formatLastSync(network.last_sync_at)}</span>
    <span id="live-meta" class="network-live"></span>
    <button id="logout-btn" class="logout-btn">Log out</button>
  `
  updateLiveMeta()

  document.getElementById('logout-btn').onclick = async () => {
    await fetch('/api/logout', { method: 'POST' })
    network = null
    networkId = null
    showLogin()
  }
}

function rowStatusClass(label, target) {
  const s = itemStatus
  if (!s.crafting && !s.failed && !s.requested && !s.waiting_cpu) return ''
  if (s.failed?.[label]) return 'status-error'
  if (s.crafting?.[label]) return 'status-crafting'
  // Deferred to the next cycle for want of a free CPU -- not a failure.
  if (s.waiting_cpu?.[label]) return 'status-waiting'
  if (s.requested?.[label]) return 'status-ok'
  if (stock[label] !== undefined && target.threshold !== null && stock[label] >= target.threshold) return 'status-ok'
  return ''
}

function getSortedTargets() {
  const list = [...targets]
  if (currentSort === 'az') {
    list.sort((a, b) => a.label.localeCompare(b.label))
  } else if (currentSort === 'za') {
    list.sort((a, b) => b.label.localeCompare(a.label))
  } else if (currentSort === 'threshold-lh') {
    list.sort((a, b) => {
      const ta = a.threshold === null ? Infinity : a.threshold
      const tb = b.threshold === null ? Infinity : b.threshold
      return ta - tb
    })
  } else if (currentSort === 'threshold-hl') {
    list.sort((a, b) => {
      const ta = a.threshold === null ? Infinity : a.threshold
      const tb = b.threshold === null ? Infinity : b.threshold
      return tb - ta
    })
  }
  // 'default' and 'custom' both mean "the order the server holds", which is the
  // order /api/targets already returns.
  return list
}

// Groups are rows on the server, membership is a column on the targets. Rebuild
// the shape the table code has always worked with: labels in row order.
function loadGroups() {
  const byId = new Map(groups.map(g => [g.id, { ...g, labels: [] }]))
  for (const t of targets) {
    const g = byId.get(t.group_id)
    if (g) g.labels.push(t.label)
  }
  return [...byId.values()].filter(g => g.labels.length >= 2)
}

function findGroup(id) {
  return loadGroups().find(g => g.id === id) ?? null
}

/**
 * Pushes a whole group layout. Membership rides on the targets, so the local
 * copies of both are patched first and the table redrawn immediately -- the
 * refetch afterwards is what reconciles with whatever the server actually kept
 * (it drops groups that ended up with fewer than two members).
 */
async function saveGroups(next) {
  const labelToId = new Map()
  for (const g of next) for (const label of g.labels) labelToId.set(label, g.id)

  const known = new Set(groups.map(g => g.id))
  groups = next.map(g => ({
    id: g.id,
    name: g.name,
    collapsed: g.collapsed ? 1 : 0,
    interval_s: g.interval_s ?? null,
    min_tps: g.min_tps ?? null,
    run_seq: g.run_seq ?? 0
  }))
  targets = targets.map(t => ({ ...t, group_id: labelToId.get(t.label) ?? null }))
  renderTable()

  try {
    const res = await fetch('/api/groups', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Schedule fields go only with groups the server has never seen. Leaving
        // them off an existing group makes the server keep what it has, so
        // redrawing brackets from a page that loaded before somebody set an
        // interval cannot wipe that interval.
        groups: next.map(g => known.has(g.id)
          ? { id: g.id, name: g.name, collapsed: !!g.collapsed, labels: g.labels }
          : {
              id: g.id,
              name: g.name,
              collapsed: !!g.collapsed,
              interval_s: g.interval_s ?? null,
              min_tps: g.min_tps ?? null,
              labels: g.labels
            })
      })
    })
    if (!res.ok) throw new Error()
    isDirty = true
  } catch {
    showToast(msg.groupFailed, 'error')
  }

  await Promise.all([fetchTargets(), fetchGroups()])
  renderTable()
}

async function patchGroup(id, patch) {
  const local = groups.find(g => g.id === id)
  if (local) Object.assign(local, patch)
  try {
    const res = await fetch(`/api/groups/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    })
    if (!res.ok) throw new Error()
    isDirty = true
  } catch {
    showToast(msg.groupFailed, 'error')
    await fetchGroups()
    renderTable()
  }
}

async function removeGroup(id) {
  groups = groups.filter(g => g.id !== id)
  targets = targets.map(t => (t.group_id === id ? { ...t, group_id: null } : t))
  renderTable()
  try {
    const res = await fetch(`/api/groups/${id}`, { method: 'DELETE' })
    if (!res.ok) throw new Error()
    isDirty = true
  } catch {
    showToast(msg.groupFailed, 'error')
  }
  await Promise.all([fetchTargets(), fetchGroups()])
  renderTable()
}

// Bumps a counter; the maintainer notices it on its next poll (<= poll interval,
// 10s by default) and moves that schedule's next run to right now.
async function runNow(groupId) {
  const key = groupId === null ? 'default' : String(groupId)
  pendingRun[key] = Date.now()
  renderSchedulePanel()
  try {
    const res = await fetch(groupId === null ? '/api/run-now' : `/api/run-now/${groupId}`, { method: 'POST' })
    if (!res.ok) throw new Error()
  } catch {
    delete pendingRun[key]
    showToast('Failed to queue the run: server unreachable.', 'error')
    renderSchedulePanel()
  }
}

function buildRowPlan(sortedTargets, groups) {
  const labelToGroup = new Map()
  for (const g of groups) {
    for (const label of g.labels) labelToGroup.set(label, g)
  }
  const plan = []
  const seen = new Set()
  for (const t of sortedTargets) {
    const group = labelToGroup.get(t.label)
    if (!group) {
      plan.push({ type: 'item', target: t })
      continue
    }
    if (seen.has(group.id)) continue
    seen.add(group.id)
    if (group.collapsed) {
      plan.push({ type: 'group-collapsed', group })
    } else {
      const members = sortedTargets.filter(x => group.labels.includes(x.label))
      members.forEach((gt, i) => {
        const pos = i === 0 ? 'first' : i === members.length - 1 ? 'last' : 'middle'
        plan.push({ type: 'group-' + pos, target: gt, group })
      })
    }
  }
  return plan
}

// How stale a collapsed group's stock counts are. A 30-minute group legitimately
// shows half-hour-old numbers, which looks like a bug without this.
function formatAge(secs) {
  if (secs === null || secs === undefined) return ''
  if (secs < 60) return `${Math.max(0, Math.round(secs))}s ago`
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  return `${Math.round(secs / 3600)}h ago`
}

function groupAge(key) {
  const ago = itemStatus.group_checked?.[String(key)]
  return typeof ago === 'number' ? ago : null
}

function renderCollapsedGroupRow(group, grabDisabled) {
  const icons = group.labels.slice(0, 5).map(label => {
    const reg = registry.find(r => r.label === label)
    return iconHtml(reg?.x, reg?.y)
  }).join('')
  const extra = group.labels.length > 5 ? `<span class="group-extra-count">+${group.labels.length - 5}</span>` : ''
  const groupTargets = targets.filter(t => group.labels.includes(t.label))
  const allEnabled = groupTargets.length > 0 && groupTargets.every(t => t.enabled !== 0)
  const schedule = group.interval_s
    ? `every ${group.interval_s}s`
    : 'default schedule'
  const age = groupAge(group.interval_s ? group.id : 0)
  const badge = `<span class="group-schedule-badge">${schedule}${age === null ? '' : ` &middot; checked ${formatAge(age)}`}</span>`
  return `
    <tr class="group-collapsed-row" data-group-id="${group.id}">
      <td class="bracket-cell bracket-collapse-zone" data-group-id="${group.id}"></td>
      <td>
        <div class="grab-handle ${grabDisabled ? 'grab-handle-disabled' : ''}">
          <span></span><span></span>
          <span></span><span></span>
          <span></span><span></span>
        </div>
      </td>
      <td>
        <button class="mc-toggle ${allEnabled ? 'mc-toggle-on' : 'mc-toggle-off'} group-toggle-btn" data-group-id="${group.id}">
          ${allEnabled ? 'Enabled' : 'Disabled'}
        </button>
      </td>
      <td><div class="group-icons">${icons}${extra}</div></td>
      <td>${badge}</td>
      <td colspan="2"><input type="text" class="group-name-input" data-group-id="${group.id}" value="${escapeHtml(group.name)}"></td>
      <td><button class="expand-btn" data-group-id="${group.id}">Expand</button></td>
    </tr>
  `
}

function setupBracketDrag(container) {
  const tbody = container.querySelector('tbody')
  if (!tbody) return

  function getRows() {
    return Array.from(tbody.querySelectorAll('tr'))
  }

  function rowIndexAt(clientY) {
    const rows = getRows()
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect()
      if (clientY >= rect.top && clientY <= rect.bottom) return i
    }
    if (rows.length === 0) return -1
    if (clientY < rows[0].getBoundingClientRect().top) return 0
    return rows.length - 1
  }

  function clearPreview() {
    tbody.querySelectorAll('tr').forEach(r =>
      r.classList.remove('group-preview-first', 'group-preview-middle', 'group-preview-last')
    )
  }

  function setPreview(lo, hi) {
    clearPreview()
    const rows = getRows()
    for (let i = lo; i <= hi; i++) {
      if (!rows[i]) continue
      rows[i].classList.add(i === lo ? 'group-preview-first' : i === hi ? 'group-preview-last' : 'group-preview-middle')
    }
  }

  function commitGroup(startIdx, endIdx) {
    const lo = Math.min(startIdx, endIdx)
    const hi = Math.max(startIdx, endIdx)
    if (lo === hi) {
      const rows = getRows()
      const row = rows[lo]
      if (!row || !row.dataset.row) return
      const isGrouped = ['group-first', 'group-middle', 'group-last'].some(c => row.classList.contains(c))
      if (!isGrouped) return
      const g = loadGroups().find(gr => gr.labels.includes(row.dataset.row))
      if (!g) return
      patchGroup(g.id, { collapsed: true })
      renderTable()
      return
    }

    const rows = getRows()
    const list = loadGroups()
    const newLabels = []
    const overlapping = []
    const seenOverlap = new Set()

    for (let i = lo; i <= hi; i++) {
      const row = rows[i]
      if (!row) continue
      if (row.dataset.row) {
        newLabels.push(row.dataset.row)
        const g = list.find(gr => gr.labels.includes(row.dataset.row))
        if (g && !seenOverlap.has(g.id)) { seenOverlap.add(g.id); overlapping.push(g) }
      } else if (row.dataset.groupId) {
        const g = list.find(gr => gr.id === parseInt(row.dataset.groupId))
        if (g) {
          newLabels.push(...g.labels)
          if (!seenOverlap.has(g.id)) { seenOverlap.add(g.id); overlapping.push(g) }
        }
      }
    }

    if (newLabels.length < 2) return

    const newLabelSet = new Set(newLabels)

    const kept = list
      .map(g => ({ ...g, labels: g.labels.filter(l => !newLabelSet.has(l)) }))
      .filter(g => g.labels.length >= 2)

    // Ids must not collide with a group that is only losing members here, so
    // count the whole layout rather than just the survivors.
    const takenIds = list.map(g => g.id)
    const id = takenIds.length === 0 ? 1 : Math.max(...takenIds) + 1
    // Swallowing an existing group inherits its name and its schedule.
    const absorbed = overlapping[0]
    kept.push({
      id,
      name: absorbed ? absorbed.name : 'Group ' + id,
      labels: newLabels,
      collapsed: false,
      interval_s: absorbed?.interval_s ?? null,
      min_tps: absorbed?.min_tps ?? null
    })
    saveGroups(kept)
  }

  container.querySelectorAll('td.bracket-cell').forEach(cell => {
    // Collapsing and expanding is navigation, so it works in any ordered mode --
    // only the gestures that *change* a group need Custom.
    cell.addEventListener('click', (e) => {
      if (!ORDERED_MODES.includes(currentSort)) return
      const row = cell.closest('tr')

      if (cell.classList.contains('bracket-collapse-zone')) {
        const g = findGroup(parseInt(row.dataset.groupId))
        if (!g) return
        patchGroup(g.id, { collapsed: false })
        renderTable()
        return
      }

      // Clicking the bracket line beside an expanded group folds it up. In
      // Custom the drag machinery below already does this on mouseup; this is
      // what makes it work in Default too, where expanding always did.
      if (currentSort === 'custom' || !row?.dataset.row) return
      const g = loadGroups().find(gr => gr.labels.includes(row.dataset.row))
      if (!g) return
      patchGroup(g.id, { collapsed: true })
      renderTable()
    })

    cell.addEventListener('mousedown', (e) => {
      if (currentSort !== 'custom') return
      if (cell.classList.contains('bracket-collapse-zone')) return
      if (e.button !== 0) return
      e.preventDefault()

      const rows = getRows()
      const startIdx = rows.indexOf(cell.closest('tr'))
      if (startIdx === -1) return

      isDragging = true
      setPreview(startIdx, startIdx)

      function onMove(e) {
        const cur = rowIndexAt(e.clientY)
        setPreview(Math.min(startIdx, cur), Math.max(startIdx, cur))
      }

      function onUp(e) {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.removeEventListener('keydown', onKey)
        isDragging = false
        clearPreview()
        commitGroup(startIdx, rowIndexAt(e.clientY))
      }

      function onKey(e) {
        if (e.key !== 'Escape') return
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.removeEventListener('keydown', onKey)
        isDragging = false
        clearPreview()
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.addEventListener('keydown', onKey)
    })

    cell.addEventListener('contextmenu', (e) => {
      if (currentSort !== 'custom') return
      e.preventDefault()
      const row = cell.closest('tr')
      let groupId = null
      if (row.dataset.groupId) {
        groupId = parseInt(row.dataset.groupId)
      } else if (row.dataset.row) {
        groupId = loadGroups().find(g => g.labels.includes(row.dataset.row))?.id ?? null
      }
      if (groupId === null) return
      removeGroup(groupId)
    })
  })
}

function renderTable() {
  const container = document.getElementById('table-container')

  updateStatusCounts()

  const grabDisabled = !ORDERED_MODES.includes(currentSort)

  const sortedTargets = getSortedTargets()
  // Brackets need the saved row order to draw contiguous groups, which both
  // ordered modes have. Alphabetical/threshold views scatter the members.
  const plan = buildRowPlan(sortedTargets, grabDisabled ? [] : loadGroups())

  const rows = plan.map(entry => {
    if (entry.type === 'group-collapsed') return renderCollapsedGroupRow(entry.group, grabDisabled)

    const t = entry.target
    const count = stock[t.label]
    const stockDisplay = count === undefined ? '...' : formatCount(count)
    const stockTitle = count === undefined ? 'Loading...' : String(count)
    const thresholdVal = formatShort(t.threshold)
    const batchVal = formatShort(t.batch_size ?? 1)
    const enabled = t.enabled !== 0
    const groupCls = entry.type !== 'item' ? entry.type : ''
    const rowClass = [rowStatusClass(t.label, t), enabled ? '' : 'row-disabled', groupCls].filter(Boolean).join(' ')

    return `
      <tr data-row="${t.label}" class="${rowClass}">
        <td class="bracket-cell" data-row="${t.label}"></td>
        <td>
          <div class="grab-handle ${grabDisabled ? 'grab-handle-disabled' : ''}">
            <span></span><span></span>
            <span></span><span></span>
            <span></span><span></span>
          </div>
        </td>
        <td>
          <button class="mc-toggle ${enabled ? 'mc-toggle-on' : 'mc-toggle-off'}" data-toggle="${t.label}">
            ${enabled ? 'Enabled' : 'Disabled'}
          </button>
        </td>
        <td>
          <div class="item-slot" data-change="${t.label}">
            ${iconHtml(t.x, t.y)}
            <span>${t.label}</span>
          </div>
        </td>
        <td id="stock-${t.label}" title="${stockTitle}">${stockDisplay}</td>
        <td>
          <input type="text" value="${thresholdVal}" placeholder="infinite"
            data-label="${t.label}" data-field="threshold">
        </td>
        <td>
          <input type="text" value="${batchVal}"
            data-label="${t.label}" data-field="batch_size">
        </td>
        <td>
          <button data-delete="${t.label}">Delete</button>
        </td>
      </tr>
    `
  }).join('')

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th></th>
          <th></th>
          <th></th>
          <th>Item</th>
          <th>Stock</th>
          <th>Threshold</th>
          <th>Batch size</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `

  container.querySelectorAll('input[data-field]').forEach(input => {
    let savedValue = input.value
    input.addEventListener('focus', () => {
      const label = input.dataset.label
      const field = input.dataset.field
      const t = targets.find(x => x.label === label)
      if (t) {
        const rawVal = t[field]
        input.value = rawVal === null || rawVal === undefined ? '' : rawVal.toLocaleString()
      }
      savedValue = input.value
    })
    input.addEventListener('blur', () => {
      if (input.value === '') {
        const field = input.dataset.field
        if (field === 'batch_size') {
          input.value = savedValue
          return
        }
        if (savedValue !== '') {
          saveTarget(input.dataset.label, getRowData(input.dataset.label))
            .catch(() => {
              input.value = savedValue
            })
        }
        return
      }
      let parsed = parseAmount(input.value)
      if (parsed === null) {
        showToast('Invalid format', 'error')
        input.value = savedValue
        return
      }
      if (parsed > 9000000000000000) parsed = 9000000000000000
      input.value = formatShort(parsed)
      if (input.value !== savedValue) {
        saveTarget(input.dataset.label, getRowData(input.dataset.label))
          .catch(() => {
            input.value = savedValue
          })
      }
    })
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur()
      if (e.key === 'Escape') {
        input.value = savedValue
        input.blur()
      }
    })
  })

  container.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => removeTarget(btn.dataset.delete))
  })

  container.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const label = btn.dataset.toggle
      const t = targets.find(t => t.label === label)
      if (!t) return
      saveTarget(label, { ...getRowData(label), enabled: t.enabled === 0 })
        .then(fetchTargets)
        .then(render)
    })
  })

  container.querySelectorAll('[data-change]').forEach(slot => {
    slot.addEventListener('click', () => {
      const label = slot.dataset.change
      // Swapping the item on a row is inherently one-for-one.
      openItemPicker(([{ label: newLabel, is_fluid }]) => {
        if (newLabel !== label) changeTargetItem(label, newLabel, is_fluid)
      }, { multi: false })
    })
  })

  container.querySelectorAll('.group-toggle-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const g = findGroup(parseInt(btn.dataset.groupId))
      if (!g) return
      const groupTargets = targets.filter(t => g.labels.includes(t.label))
      const allEnabled = groupTargets.every(t => t.enabled !== 0)
      await Promise.all(groupTargets.map(t =>
        saveTarget(t.label, { threshold: t.threshold, batch_size: t.batch_size, is_fluid: t.is_fluid ?? false, enabled: !allEnabled })
      ))
      await fetchTargets()
      render()
    })
  })

  container.querySelectorAll('.expand-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const g = findGroup(parseInt(btn.dataset.groupId))
      if (!g) return
      patchGroup(g.id, { collapsed: false })
      renderTable()
    })
  })

  container.querySelectorAll('.group-name-input').forEach(input => {
    let savedName = input.value
    input.addEventListener('focus', () => { savedName = input.value })
    input.addEventListener('blur', () => {
      const groupId = parseInt(input.dataset.groupId)
      const name = input.value.trim() || savedName
      input.value = name
      if (name !== savedName) patchGroup(groupId, { name }).then(renderSchedulePanel)
    })
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur()
      if (e.key === 'Escape') { input.value = savedName; input.blur() }
    })
  })

  renderAddPanel()
  renderSchedulePanel()
  setupBracketDrag(container)

  let draggedRow = null
  let dropGroupId = null

  function clearDropTarget() {
    dropGroupId = null
    container.querySelectorAll('tr.group-drop-target').forEach(r => r.classList.remove('group-drop-target'))
  }

  function moveDraggedTo(e, targetRow) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!draggedRow || targetRow === draggedRow) return
    if (targetRow.parentNode !== draggedRow.parentNode) return
    const rect = targetRow.getBoundingClientRect()
    const anchor = (e.clientY - rect.top) / (rect.bottom - rect.top) > 0.5 ? targetRow.nextSibling : targetRow
    targetRow.parentNode.insertBefore(draggedRow, anchor)
  }

  container.querySelectorAll('tr[data-row]').forEach(row => {
    let dragAllowed = false
    row.addEventListener('mousedown', (e) => {
      dragAllowed = !!e.target.closest('.grab-handle')
    })

    row.setAttribute('draggable', 'true')

    row.addEventListener('dragstart', (e) => {
      if (!ORDERED_MODES.includes(currentSort)) {
        e.preventDefault()
        showToast("Switch to 'Custom' sorting to drag and reorder items.", "error")
        return
      }
      if (!dragAllowed) {
        e.preventDefault()
        return
      }
      draggedRow = row
      isDragging = true
      row.classList.add('dragging')
      e.dataTransfer.effectAllowed = 'move'
    })

    const handle = row.querySelector('.grab-handle')
    if (handle) {
      handle.addEventListener('click', () => {
        if (!ORDERED_MODES.includes(currentSort)) {
          showToast("Switch to 'Custom' sorting to drag and reorder items.", "error")
        }
      })
    }

    // Order first, then membership: autoJoinGroup refetches the targets, and a
    // refetch that overtakes the order write would snap the row back.
    row.addEventListener('dragend', async (e) => {
      if (!draggedRow) { isDragging = false; return }
      draggedRow.classList.remove('dragging')
      const label = draggedRow.dataset.row
      const targetGroupId = dropGroupId
      draggedRow = null
      isDragging = false
      clearDropTarget()
      await saveCustomOrder()
      // Dropped onto a collapsed group row: file the item into that group.
      // dropEffect is 'none' when the drag was cancelled (Escape).
      if (targetGroupId !== null && e.dataTransfer.dropEffect !== 'none' && joinGroup(label, targetGroupId)) return
      autoJoinGroup(label)
    })

    row.addEventListener('dragover', (e) => {
      clearDropTarget()
      moveDraggedTo(e, row)
    })
  })

  container.querySelectorAll('tr[data-group-id]').forEach(row => {
    let dragAllowed = false
    row.addEventListener('mousedown', (e) => {
      dragAllowed = !!e.target.closest('.grab-handle')
    })

    // Clicking the handle without dragging opens the group -- the same gesture
    // the bracket column already answers to. A real drag fires dragstart/dragend
    // instead of click, so reordering still works.
    const handle = row.querySelector('.grab-handle')
    if (handle) {
      handle.addEventListener('click', () => {
        if (!ORDERED_MODES.includes(currentSort)) return
        const g = findGroup(parseInt(row.dataset.groupId))
        if (!g) return
        patchGroup(g.id, { collapsed: false })
        renderTable()
      })
    }
    row.setAttribute('draggable', 'true')
    row.addEventListener('dragstart', (e) => {
      if (!ORDERED_MODES.includes(currentSort)) { e.preventDefault(); return }
      if (!dragAllowed) { e.preventDefault(); return }
      draggedRow = row
      isDragging = true
      row.classList.add('dragging')
      e.dataTransfer.effectAllowed = 'move'
    })
    row.addEventListener('dragend', () => {
      if (draggedRow) {
        draggedRow.classList.remove('dragging')
        draggedRow = null
      }
      isDragging = false
      clearDropTarget()
      saveCustomOrder()
    })
    row.addEventListener('dragover', (e) => {
      // An item dragged over a collapsed group targets the group (folder drop);
      // a group dragged over another group just reorders as before.
      if (draggedRow?.dataset?.row !== undefined) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const gid = parseInt(row.dataset.groupId)
        if (dropGroupId !== gid) {
          clearDropTarget()
          dropGroupId = gid
          row.classList.add('group-drop-target')
        }
        return
      }
      moveDraggedTo(e, row)
    })
  })
}

function renderAddPanel() {
  const container = document.getElementById('add-container')
  if (!container) return

  const groups = loadGroups()
  // A group that vanished (members deleted, bracket removed) must not linger as
  // the selected destination.
  if (addDefaults.group_id !== null && !groups.some(g => g.id === addDefaults.group_id)) {
    addDefaults.group_id = null
  }
  const destination = groups.find(g => g.id === addDefaults.group_id) ?? null

  const slotHtml = pendingAdds.length === 0
    ? `<div class="item-slot item-slot-empty" id="add-slot">Click to select item</div>`
    : pendingAdds.length === 1
      ? `<div class="item-slot item-slot-pick" id="add-slot">${iconHtml(pendingAdds[0].x, pendingAdds[0].y)}<span>${pendingAdds[0].label}</span></div>`
      : `<div class="item-slot item-slot-pick" id="add-slot" title="${pendingAdds.map(p => p.label).join(', ')}">
           ${pendingAdds.slice(0, 6).map(p => iconHtml(p.x, p.y)).join('')}
           <span>${pendingAdds.length} items</span>
         </div>`

  const threshVal = addDefaults.threshold != null ? formatShort(addDefaults.threshold) : ''
  const batchVal = addDefaults.batch_size != null ? formatShort(addDefaults.batch_size) : '1'
  const addEnabled = addDefaults.enabled

  // The button says where things are going, so the destination is never a
  // surprise -- and it stays selected, so a run of items is one click each.
  const addLabel = pendingAdds.length > 1
    ? (destination ? `Add ${pendingAdds.length} to ${escapeHtml(destination.name)}` : `Add ${pendingAdds.length} items`)
    : (destination ? `Add to ${escapeHtml(destination.name)}` : 'Add')

  container.innerHTML = `
    <div class="inventory-title">Add new item</div>
    <div class="add-fields">
      <div class="add-field-cell">
        <button id="add-toggle" class="mc-toggle ${addEnabled ? 'mc-toggle-on' : 'mc-toggle-off'}">
          ${addEnabled ? 'Enabled' : 'Disabled'}
        </button>
      </div>
      <div class="add-field-cell add-field-item">
        ${slotHtml}
      </div>
      <div class="add-field-cell">
        <input id="add-threshold" type="text" placeholder="infinite" value="${threshVal}">
      </div>
      <div class="add-field-cell">
        <input id="add-batch" type="text" placeholder="1" value="${batchVal}">
      </div>
      ${groups.length ? `
      <div class="add-field-cell">
        <select id="add-group" title="Drop the new items straight into a group">
          <option value="">No group</option>
          ${groups.map(g => `<option value="${g.id}" ${g.id === addDefaults.group_id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join('')}
        </select>
      </div>` : ''}
      <div class="add-field-cell">
        <button id="add-btn" ${pendingAdds.length ? '' : 'disabled'}>${addLabel}</button>
      </div>
    </div>
  `

  ;['add-threshold', 'add-batch'].forEach(id => {
    const input = document.getElementById(id)
    if (!input) return
    const field = id === 'add-threshold' ? 'threshold' : 'batch_size'
    let savedValue = input.value
    input.addEventListener('focus', () => {
      const raw = addDefaults[field]
      input.value = raw === null || raw === undefined ? '' : raw.toLocaleString()
      savedValue = input.value
    })
    input.addEventListener('blur', () => {
      if (input.value === '') {
        if (field === 'batch_size') { input.value = savedValue; return }
        addDefaults[field] = null
        return
      }
      let parsed = parseAmount(input.value)
      if (parsed === null) { showToast('Invalid format', 'error'); input.value = savedValue; return }
      if (parsed > 9000000000000000) parsed = 9000000000000000
      addDefaults[field] = parsed
      input.value = formatShort(parsed)
    })
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur()
      if (e.key === 'Escape') { input.value = savedValue; input.blur() }
    })
  })

  document.getElementById('add-slot').onclick = () => {
    openItemPicker(items => {
      pendingAdds = items.map(item => {
        const reg = registry.find(i => i.label === item.label)
        return { ...item, x: reg?.x, y: reg?.y }
      })
      renderAddPanel()
    })
  }

  document.getElementById('add-toggle').onclick = () => {
    addDefaults.enabled = !addDefaults.enabled
    renderAddPanel()
  }

  const groupSelect = document.getElementById('add-group')
  if (groupSelect) {
    groupSelect.onchange = () => {
      addDefaults.group_id = groupSelect.value === '' ? null : Number(groupSelect.value)
      renderAddPanel()
    }
  }

  if (pendingAdds.length) {
    document.getElementById('add-btn').onclick = () => {
      const threshStr = document.getElementById('add-threshold').value
      const batchStr = document.getElementById('add-batch').value || '1'
      if (threshStr && parseAmount(threshStr) === null) {
        showToast('Invalid threshold format', 'error')
        return
      }
      if (parseAmount(batchStr) === null) {
        showToast('Invalid batch size format', 'error')
        return
      }
      addTargets(pendingAdds, threshStr, batchStr, addDefaults.enabled, addDefaults.group_id)
    }
  }
}

/**
 * One row per schedule the maintainer runs: the default one (ungrouped items plus
 * every group without its own interval) and each group that set an interval.
 * Lives outside the table because a group's schedule matters in every sort mode,
 * while its bracket only draws in the ordered ones.
 */
function renderSchedulePanel() {
  const container = document.getElementById('schedule-container')
  if (!container) return
  // Never redraw under the user's cursor while they are typing an interval. Only
  // fields count: a clicked button holds focus too, and its own click needs the
  // redraw to show "queued...".
  const active = document.activeElement
  if (active && active.tagName === 'INPUT' && container.contains(active)) return

  const list = loadGroups()
  const scheduled = list.filter(g => g.interval_s)
  const defaultAge = groupAge(0)
  const gatedNow = g => g.min_tps !== null && g.min_tps !== undefined
    && typeof itemStatus.tps === 'number' && itemStatus.tps < g.min_tps

  // What the toggle says while it is shut: enough to see the schedule at a
  // glance without opening anything.
  const summary = scheduled.length === 0
    ? 'all on the default schedule'
    : scheduled.map(g => `${escapeHtml(g.name)} ${g.interval_s}s`).join(' &middot; ')
      + (list.length > scheduled.length ? ` &middot; ${list.length - scheduled.length} on default` : '')

  const held = list.filter(gatedNow).length

  const groupRows = list.map(g => {
    const own = !!g.interval_s
    const age = groupAge(g.id)
    const pending = !!pendingRun[String(g.id)]
    return `
      <div class="schedule-row">
        <span class="schedule-name">${escapeHtml(g.name)}</span>
        <label class="schedule-field">every
          <input type="number" min="5" max="86400" class="schedule-interval" data-group-id="${g.id}"
            value="${g.interval_s ?? ''}" placeholder="${maintainerSleep}"> s</label>
        <label class="schedule-field" title="The group's timer only fires while the measured server TPS is at least this high.">min TPS
          <input type="number" min="0" max="20" step="0.5" class="schedule-tps" data-group-id="${g.id}"
            value="${g.min_tps ?? ''}" placeholder="off"></label>
        ${gatedNow(g) ? '<span class="schedule-age schedule-gated">TPS gate closed</span>' : ''}
        ${own
          // Only a group with its own timer has an age of its own -- otherwise it
          // is the default schedule's, already shown on the row above.
          ? `<span class="schedule-age">${age === null ? '' : 'checked ' + formatAge(age)}</span>
             <button class="run-now-btn" data-run="${g.id}" ${pending ? 'disabled' : ''}>${pending ? 'queued...' : 'Run now'}</button>`
          : '<span class="schedule-age schedule-muted">default schedule</span>'}
      </div>
    `
  }).join('')

  container.innerHTML = `
    <div class="inventory-title">Schedules</div>
    <div class="schedule-row">
      <span class="schedule-name">Default schedule</span>
      <span class="schedule-detail">every ${maintainerSleep}s &middot; ungrouped items${
        list.length > scheduled.length ? ' and groups without an interval' : ''}</span>
      <span class="schedule-age">${defaultAge === null ? '' : 'checked ' + formatAge(defaultAge)}</span>
      <button class="run-now-btn" data-run="default" ${pendingRun.default ? 'disabled' : ''}>
        ${pendingRun.default ? 'queued...' : 'Run now'}
      </button>
    </div>
    ${list.length === 0
      ? '<div class="schedule-hint">Group rows together in Custom sorting to give them their own interval.</div>'
      : `<button id="schedule-toggle" class="schedule-toggle" aria-expanded="${schedulesOpen}">
           <span class="schedule-caret">${schedulesOpen ? '&#9662;' : '&#9656;'}</span>
           <span class="schedule-toggle-label">${list.length} group${list.length === 1 ? '' : 's'}</span>
           <span class="schedule-summary">${schedulesOpen ? '' : summary}</span>
           ${held ? `<span class="schedule-gated">${held} held by TPS</span>` : ''}
         </button>
         <div class="schedule-groups" ${schedulesOpen ? '' : 'hidden'}>${groupRows}</div>`}
  `

  const toggle = container.querySelector('#schedule-toggle')
  if (toggle) {
    toggle.addEventListener('click', () => {
      schedulesOpen = !schedulesOpen
      localStorage.setItem('maintainer_schedules_open', String(schedulesOpen))
      renderSchedulePanel()
    })
  }

  container.querySelectorAll('.run-now-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.run
      runNow(key === 'default' ? null : parseInt(key))
    })
  })

  const commitField = (input, field, min, max) => {
    const groupId = parseInt(input.dataset.groupId)
    const raw = input.value.trim()
    if (raw === '') {
      patchGroup(groupId, { [field]: null }).then(renderTable)
      return
    }
    const val = Number(raw)
    if (!Number.isFinite(val) || val < min || val > max) {
      showToast(`Enter ${min}-${max}, or leave it empty.`, 'error')
      renderSchedulePanel()
      return
    }
    // renderTable so a collapsed group's "every 600s" badge follows along; the
    // panel itself skips the redraw while the cursor is still in it.
    patchGroup(groupId, { [field]: field === 'interval_s' ? Math.floor(val) : val }).then(renderTable)
  }

  container.querySelectorAll('.schedule-interval').forEach(input => {
    input.addEventListener('change', () => commitField(input, 'interval_s', 5, 86400))
  })
  container.querySelectorAll('.schedule-tps').forEach(input => {
    input.addEventListener('change', () => commitField(input, 'min_tps', 0, 20))
  })
}

// Folder drop: move one label into an existing group. saveGroups handles the
// server write, redraw and the dissolution of any group left with one member.
function joinGroup(label, groupId) {
  const groups = loadGroups()
  const target = groups.find(g => g.id === groupId)
  if (!target || target.labels.includes(label)) return false
  saveGroups(groups
    .map(g => g.id === groupId
      ? { ...g, labels: [...g.labels, label] }
      : { ...g, labels: g.labels.filter(l => l !== label) })
    .filter(g => g.labels.length >= 2))
  return true
}

function autoJoinGroup(label) {
  if (currentSort !== 'custom') return
  const tbody = document.querySelector('table tbody')
  if (!tbody) return
  const row = tbody.querySelector(`tr[data-row="${CSS.escape(label)}"]`)
  if (!row) return

  let list = loadGroups()

  // Remove from current group if it's in one
  const currentGroup = list.find(g => g.labels.includes(label))
  if (currentGroup) {
    list = list
      .map(g => g.id === currentGroup.id ? { ...g, labels: g.labels.filter(l => l !== label) } : g)
      .filter(g => g.labels.length >= 2)
  }

  // Only auto-join if both immediate neighbors are regular item rows in the same group
  const prev = row.previousElementSibling
  const next = row.nextElementSibling
  const labelToGroup = new Map()
  for (const g of list) for (const l of g.labels) labelToGroup.set(l, g)
  const prevGroup = prev?.dataset?.row ? labelToGroup.get(prev.dataset.row) : null
  const nextGroup = next?.dataset?.row ? labelToGroup.get(next.dataset.row) : null

  if (prevGroup && nextGroup && prevGroup.id === nextGroup.id) {
    list = list.map(g => g.id === prevGroup.id ? { ...g, labels: [...g.labels, label] } : g)
  } else if (!currentGroup) {
    renderTable()
    return
  }
  saveGroups(list)
}

// Row order is shared state now, so a drag writes it to the server. The DOM is
// the truth here: it holds the order the user just dropped rows into.
async function saveCustomOrder() {
  const list = loadGroups()
  const seenGroupIds = new Set()
  const rowLabels = []
  for (const row of document.querySelectorAll('table tbody tr')) {
    if (row.dataset.row) {
      rowLabels.push(row.dataset.row)
    } else if (row.dataset.groupId) {
      const gid = parseInt(row.dataset.groupId)
      if (seenGroupIds.has(gid)) continue
      seenGroupIds.add(gid)
      const g = list.find(g => g.id === gid)
      if (g) rowLabels.push(...g.labels)
    }
  }
  if (!rowLabels.length) return

  // 'default' shows the same saved order, so switching costs the user nothing
  // visually -- it just turns the drag and bracket gestures on.
  if (currentSort !== 'custom') {
    currentSort = 'custom'
    localStorage.setItem('maintainer_sort_mode', 'custom')
    const select = document.getElementById('sort-select')
    if (select) select.value = 'custom'
    showToast('Switched to Custom sorting.', 'success')
  }

  const rank = new Map(rowLabels.map((label, i) => [label, i]))
  targets = [...targets].sort((a, b) => (rank.get(a.label) ?? Infinity) - (rank.get(b.label) ?? Infinity))

  try {
    const res = await fetch('/api/order', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: rowLabels })
    })
    if (!res.ok) throw new Error()
    isDirty = true
  } catch {
    showToast(msg.orderFailed, 'error')
    await fetchTargets()
    renderTable()
  }
}

function getRowData(label) {
  const thresholdInput = document.querySelector(`input[data-label="${CSS.escape(label)}"][data-field="threshold"]`)
  const batchInput = document.querySelector(`input[data-label="${CSS.escape(label)}"][data-field="batch_size"]`)
  const target = targets.find(t => t.label === label)

  let threshold = thresholdInput.value === '' ? null : (parseAmount(thresholdInput.value) ?? Number(thresholdInput.value))
  if (threshold !== null && threshold > 9000000000000000) threshold = 9000000000000000
  let batch = parseAmount(batchInput.value) ?? Number(batchInput.value) ?? 1
  if (batch > 9000000000000000) batch = 9000000000000000

  return {
    threshold,
    batch_size: batch,
    is_fluid: target?.is_fluid ?? false,
    enabled: target ? target.enabled !== 0 : true
  }
}

// A queued run clears once the maintainer reports a check that happened after the
// click. 90s is the escape hatch for a maintainer that never answers.
function reconcilePendingRuns() {
  for (const [key, clickedAt] of Object.entries(pendingRun)) {
    const sinceClick = (Date.now() - clickedAt) / 1000
    const group = key === 'default' ? null : groups.find(g => g.id === Number(key))
    const age = groupAge(group?.interval_s ? group.id : 0)
    if (sinceClick > 90 || (age !== null && age < sinceClick)) delete pendingRun[key]
  }
}

/**
 * Groups and row order used to live in this browser's localStorage, which meant
 * the maintainer could not see them and two browsers disagreed. Hand whatever
 * this browser still holds to the server once, then forget it locally.
 */
async function migrateLocalLayout() {
  const groupKey = `maintainer_groups_${networkId}`
  const orderKey = `maintainer_custom_order_${networkId}`
  const rawGroups = localStorage.getItem(groupKey)
  const rawOrder = localStorage.getItem(orderKey)
  if (!rawGroups && !rawOrder) return

  const known = new Set(targets.map(t => t.label))
  try {
    // Order first: groups are stored as label lists, but they are drawn from row
    // order, so the positions have to be in place before the brackets are.
    if (rawOrder && targets.every(t => !t.position)) {
      const labels = JSON.parse(rawOrder).filter(l => known.has(l))
      if (labels.length) {
        const res = await fetch('/api/order', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labels })
        })
        if (!res.ok) throw new Error()
      }
    }
    if (rawGroups && groups.length === 0) {
      const local = JSON.parse(rawGroups)
        .map(g => ({
          id: g.id,
          name: g.name,
          collapsed: !!g.collapsed,
          labels: (g.labels ?? []).filter(l => known.has(l))
        }))
        .filter(g => Number.isInteger(g.id) && g.id > 0 && g.labels.length >= 2)
      if (local.length) {
        const res = await fetch('/api/groups', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ groups: local })
        })
        if (!res.ok) throw new Error()
      }
    }
    localStorage.removeItem(groupKey)
    localStorage.removeItem(orderKey)
    await Promise.all([fetchTargets(), fetchGroups()])
    showToast('Groups and row order now live on the server.', 'success')
  } catch {
    // Keep the local copy and try again next load rather than losing the layout.
    showToast('Could not upload this browser\'s groups yet, will retry.', 'error')
  }
}

async function init() {
  try {
    network = await fetchMe()
    if (network === null) { showLogin(); return }
    networkId = network.id
    await fetchRegistry()
    await Promise.all([fetchTargets(), fetchGroups(), fetchStock(), fetchStatus(), fetchSettings()])
    await migrateLocalLayout()
    render()
    connectWs()
  } catch {
    app.innerHTML = `<p>${msg.serverDown}</p>`
  }
}

init()
