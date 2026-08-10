const app = document.getElementById('app')

const msg = {
  addFailed: 'Failed to add target: server unreachable.',
  deleteFailed: 'Failed to delete target: server unreachable.',
  saveFailed: 'Failed to save target: server unreachable or invalid value.',
  serverDown: 'Failed to connect to server. Is it running?',
  loginFailed: 'Wrong password.'
}

let networkId = null
let targets = []
let stock = {}
let networks = []
let registry = []
let itemStatus = {}
const timers = {}
let sleepTimer = null
let maintainerSleep = 10
let pendingAdd = null
let isDirty = false
let currentSort = localStorage.getItem('maintainer_sort_mode') || 'default'
let isDragging = false

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
  const multipliers = { k: 1e3, m: 1e6, b: 1e9, t: 1e12, q: 1e15 }
  const s = str.toLowerCase().trim().replace(/,/g, '').replace(/(\d+\.?\d*)([kmbtq]+)/g, (_, num, suf) => {
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

async function fetchNetworks() {
  const res = await fetch('/api/networks')
  if (res.status === 401) return null
  return res.json()
}

async function fetchTargets() {
  const res = await fetch(`/api/targets/${networkId}`)
  targets = await res.json()
}

async function fetchStock() {
  const res = await fetch(`/api/stock/${networkId}`)
  const rows = await res.json()
  stock = Object.fromEntries(rows.map(r => [r.label, r.count]))
}

async function fetchRegistry() {
  const res = await fetch('/gtnh_registry.json')
  registry = await res.json()
}

async function fetchSettings() {
  const res = await fetch(`/api/settings/${networkId}`)
  const data = await res.json()
  maintainerSleep = data.maintainer_sleep ?? 10
}

function showLogin() {
  app.innerHTML = `
    <div>
      <h1>OC Level Maintainer</h1>
      <p id="login-error"></p>
      <input id="login-password" type="password" placeholder="Password">
      <button id="login-btn">Login</button>
    </div>
  `
  document.getElementById('login-btn').onclick = async () => {
    const password = document.getElementById('login-password').value
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    })
    if (res.ok) {
      init()
    } else {
      document.getElementById('login-error').textContent = msg.loginFailed
    }
  }
}

async function saveTarget(label, data) {
  try {
    const res = await fetch(`/api/targets/${networkId}/${encodeURIComponent(label)}`, {
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

async function addTarget(label, threshold, batchSize, isFluid, enabled) {
  let parsedThreshold = threshold === '' ? null : (parseAmount(threshold) ?? Number(threshold))
  if (parsedThreshold !== null && parsedThreshold > 9000000000000000) parsedThreshold = 9000000000000000
  let parsedBatch = parseAmount(batchSize) ?? Number(batchSize) ?? 1
  if (parsedBatch > 9000000000000000) parsedBatch = 9000000000000000

  try {
    const res = await fetch(`/api/targets/${networkId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label,
        threshold: parsedThreshold,
        batch_size: parsedBatch,
        is_fluid: isFluid,
        enabled
      })
    })
    if (!res.ok) throw new Error()
    isDirty = true
    await fetchTargets()
    pendingAdd = null
    render()
  } catch {
    showToast(msg.addFailed, 'error')
  }
}

async function removeTarget(label) {
  clearTimeout(timers[label])
  delete timers[label]
  try {
    const res = await fetch(`/api/targets/${networkId}/${encodeURIComponent(label)}`, { method: 'DELETE' })
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
    const res1 = await fetch(`/api/targets/${networkId}/${encodeURIComponent(oldLabel)}`, { method: 'DELETE' })
    if (!res1.ok) throw new Error()
    const res2 = await fetch(`/api/targets/${networkId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: newLabel,
        threshold: old?.threshold ?? null,
        batch_size: old?.batch_size ?? 1,
        is_fluid: newIsFluid,
        enabled: old?.enabled !== 0
      })
    })
    if (!res2.ok) throw new Error()
    isDirty = true
    await fetchTargets()
    render()
  } catch {
    showToast(msg.saveFailed, 'error')
  }
}


function openItemPicker(onSelect) {
  const overlay = document.createElement('div')
  overlay.className = 'picker-overlay'
  overlay.innerHTML = `
    <div class="picker-modal">
      <div class="picker-header">
        <input id="picker-search" type="text" placeholder="Search items..." autocomplete="off">
        <button id="picker-close">X</button>
      </div>
      <div id="picker-grid" class="picker-grid"></div>
    </div>
  `
  document.body.appendChild(overlay)

  const searchInput = overlay.querySelector('#picker-search')
  const grid = overlay.querySelector('#picker-grid')

  function renderResults(items) {
    grid.innerHTML = items.slice(0, 64).map(i => `
      <div class="picker-item" data-label="${i.label}" data-fluid="${i.is_fluid}" title="${i.label}">
        ${iconHtml(i.x, i.y)}
        <span class="picker-item-name">${i.label}</span>
      </div>
    `).join('')

    grid.querySelectorAll('.picker-item').forEach(el => {
      el.onclick = () => {
        onSelect({ label: el.dataset.label, is_fluid: el.dataset.fluid === 'true' })
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

  overlay.querySelector('#picker-close').onclick = () => overlay.remove()
  overlay.onclick = e => { if (e.target === overlay) overlay.remove() }
  searchInput.focus()
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/ws`)

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.network_id !== networkId) return

    if (msg.type === 'stock') {
      Object.assign(stock, msg.stock)
      if (msg.status) itemStatus = msg.status
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
  }

  ws.onclose = () => setTimeout(connectWs, 3000)
}

function updateStockCells() {
  for (const t of targets) {
    const cell = document.getElementById(`stock-${t.label}`)
    if (cell) {
      const count = stock[t.label]
      cell.textContent = count === undefined ? '...' : formatCount(count)
      cell.title = count === undefined ? 'Loading...' : String(count)
    }
    const row = document.querySelector(`tr[data-row="${CSS.escape(t.label)}"]`)
    if (row) row.className = rowStatusClass(t.label, t)
  }
}

function render() {
  app.innerHTML = `
    <div>
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
        <label class="sleep-setting">Check every <input id="sleep-input" type="number" min="5" value="${maintainerSleep}"> s</label>
      </div>
      <div id="network-bar"></div>
      <div class="table-toolbar">
        <div class="targets-count"><span id="active-count">0</span> / <span id="total-count">0</span> items active</div>
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
      </div>
      <div id="table-container"></div>
    </div>
  `

  document.getElementById('sleep-input').addEventListener('input', (e) => {
    const val = Math.max(1, Math.floor(Number(e.target.value)))
    if (!val) return
    clearTimeout(sleepTimer)
    sleepTimer = setTimeout(async () => {
      await fetch(`/api/settings/${networkId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maintainer_sleep: val })
      })
      maintainerSleep = val
    }, 2000)
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

function renderNetworkBar() {
  const bar = document.getElementById('network-bar')

  if (networks.length <= 1) return

  bar.innerHTML = `
    <label>Network:
      <select id="network-select">
        ${networks.map(n => `<option value="${n}"${n === networkId ? ' selected' : ''}>${n}</option>`).join('')}
      </select>
    </label>
  `

  document.getElementById('network-select').onchange = async (e) => {
    Object.keys(timers).forEach(k => { clearTimeout(timers[k]); delete timers[k] })
    networkId = e.target.value
    await Promise.all([fetchTargets(), fetchStock()])
    render()
  }
}

function rowStatusClass(label, target) {
  const s = itemStatus
  if (!s.crafting && !s.failed && !s.requested) return ''
  if (s.failed?.[label]) return 'status-error'
  if (s.crafting?.[label]) return 'status-crafting'
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
  } else if (currentSort === 'custom') {
    const savedOrder = JSON.parse(localStorage.getItem(`maintainer_custom_order_${networkId}`) || '[]')
    if (savedOrder.length > 0) {
      const activeLabels = new Set(targets.map(t => t.label))
      const cleanedOrder = savedOrder.filter(label => activeLabels.has(label))
      const orderMap = new Map(cleanedOrder.map((label, idx) => [label, idx]))
      list.sort((a, b) => {
        const idxA = orderMap.has(a.label) ? orderMap.get(a.label) : Infinity
        const idxB = orderMap.has(b.label) ? orderMap.get(b.label) : Infinity
        return idxA - idxB
      })
    }
  }
  return list
}

function renderTable() {
  const container = document.getElementById('table-container')

  // Update active/total count toolbar
  const activeCount = targets.filter(t => t.enabled !== 0).length
  const totalCount = targets.length
  const activeEl = document.getElementById('active-count')
  const totalEl = document.getElementById('total-count')
  if (activeEl) activeEl.textContent = activeCount
  if (totalEl) totalEl.textContent = totalCount

  const hasCustomOrder = !!localStorage.getItem(`maintainer_custom_order_${networkId}`)
  const grabDisabled = currentSort !== 'custom' && hasCustomOrder

  const sortedTargets = getSortedTargets()
  const rows = sortedTargets.map(t => {
    const count = stock[t.label]
    const stockDisplay = count === undefined ? '...' : formatCount(count)
    const stockTitle = count === undefined ? 'Loading...' : String(count)
    const thresholdVal = formatShort(t.threshold)
    const batchVal = formatShort(t.batch_size ?? 1)
    const enabled = t.enabled !== 0
    const opacity = enabled ? '' : 'style="opacity:0.35"'

    return `
      <tr data-row="${t.label}" class="${rowStatusClass(t.label, t)}" ${opacity}>
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

  const slotHtml = pendingAdd
    ? `<div class="item-slot item-slot-pick" id="add-slot">${iconHtml(pendingAdd.x, pendingAdd.y)}<span>${pendingAdd.label}</span></div>`
    : `<div class="item-slot item-slot-empty" id="add-slot">Click to select item</div>`

  const addThresholdVal = pendingAdd && pendingAdd.threshold !== undefined && pendingAdd.threshold !== null ? formatShort(pendingAdd.threshold) : ''
  const addBatchVal = pendingAdd && pendingAdd.batch_size !== undefined && pendingAdd.batch_size !== null ? formatShort(pendingAdd.batch_size) : '1'

  const addEnabled = pendingAdd ? (pendingAdd.enabled !== false) : true
  const addRow = `
    <tr>
      <td></td>
      <td>
        <button id="add-toggle" class="mc-toggle ${addEnabled ? 'mc-toggle-on' : 'mc-toggle-off'}" ${pendingAdd ? '' : 'disabled'}>
          ${addEnabled ? 'Enabled' : 'Disabled'}
        </button>
      </td>
      <td>${slotHtml}</td>
      <td></td>
      <td><input id="add-threshold" type="text" placeholder="infinite" value="${addThresholdVal}" ${pendingAdd ? '' : 'disabled'}></td>
      <td><input id="add-batch" type="text" placeholder="1" value="${addBatchVal}" ${pendingAdd ? '' : 'disabled'}></td>
      <td><button id="add-btn" ${pendingAdd ? '' : 'disabled'}>Add</button></td>
    </tr>
  `

  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th></th>
          <th></th>
          <th>Item</th>
          <th>Stock</th>
          <th>Threshold</th>
          <th>Batch size</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}${addRow}</tbody>
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

  ;['add-threshold', 'add-batch'].forEach(id => {
    const input = document.getElementById(id)
    if (!input || input.disabled) return
    let savedValue = input.value
    input.addEventListener('focus', () => {
      if (pendingAdd) {
        const field = id === 'add-threshold' ? 'threshold' : 'batch_size'
        const rawVal = pendingAdd[field]
        input.value = rawVal === null || rawVal === undefined ? '' : rawVal.toLocaleString()
      }
      savedValue = input.value
    })
    input.addEventListener('blur', () => {
      if (input.value === '') {
        if (pendingAdd) {
          const field = id === 'add-threshold' ? 'threshold' : 'batch_size'
          if (field === 'batch_size') {
            input.value = savedValue
            return
          }
          pendingAdd[field] = null
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
      if (pendingAdd) {
        const field = id === 'add-threshold' ? 'threshold' : 'batch_size'
        pendingAdd[field] = parsed
      }
      input.value = formatShort(parsed)
    })
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur()
      if (e.key === 'Escape') { input.value = savedValue; input.blur() }
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
      openItemPicker(({ label: newLabel, is_fluid }) => {
        if (newLabel !== label) changeTargetItem(label, newLabel, is_fluid)
      })
    })
  })

  document.getElementById('add-slot').onclick = () => {
    openItemPicker(item => {
      const reg = registry.find(i => i.label === item.label)
      pendingAdd = { ...item, x: reg?.x, y: reg?.y, enabled: true, threshold: null, batch_size: 1 }
      renderTable()
    })
  }

  if (pendingAdd) {
    document.getElementById('add-btn').onclick = () => {
      const threshold = document.getElementById('add-threshold').value
      const batch = document.getElementById('add-batch').value || '1'
      addTarget(pendingAdd.label, threshold, batch, pendingAdd.is_fluid, pendingAdd.enabled !== false)
    }
    document.getElementById('add-toggle').onclick = () => {
      pendingAdd.enabled = pendingAdd.enabled === false
      renderTable()
    }
  }

  let draggedRow = null

  container.querySelectorAll('tr[data-row]').forEach(row => {
    let dragAllowed = false
    row.addEventListener('mousedown', (e) => {
      dragAllowed = !!e.target.closest('.grab-handle')
    })

    row.setAttribute('draggable', 'true')

    row.addEventListener('dragstart', (e) => {
      const hasCustomOrder = !!localStorage.getItem(`maintainer_custom_order_${networkId}`)
      if (currentSort !== 'custom' && hasCustomOrder) {
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
      handle.addEventListener('click', (e) => {
        const hasCustomOrder = !!localStorage.getItem(`maintainer_custom_order_${networkId}`)
        if (currentSort !== 'custom' && hasCustomOrder) {
          showToast("Switch to 'Custom' sorting to drag and reorder items.", "error")
        }
      })
    }

    row.addEventListener('dragend', () => {
      if (draggedRow) {
        draggedRow.classList.remove('dragging')
        draggedRow = null
      }
      isDragging = false
      saveCustomOrder()
    })

    row.addEventListener('dragover', (e) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const targetRow = e.target.closest('tr[data-row]')
      if (targetRow && targetRow !== draggedRow && targetRow.parentNode === draggedRow.parentNode) {
        const rect = targetRow.getBoundingClientRect()
        const next = (e.clientY - rect.top) / (rect.bottom - rect.top) > 0.5
        targetRow.parentNode.insertBefore(draggedRow, next ? targetRow.nextSibling : targetRow)
      }
    })
  })
}

function saveCustomOrder() {
  const rowLabels = Array.from(document.querySelectorAll('tr[data-row]')).map(row => row.dataset.row)
  if (currentSort !== 'custom') {
    const oldCustomOrder = localStorage.getItem(`maintainer_custom_order_${networkId}`)
    const oldSortMode = currentSort
    currentSort = 'custom'
    localStorage.setItem('maintainer_sort_mode', 'custom')
    const select = document.getElementById('sort-select')
    if (select) select.value = 'custom'
    
    showToast('Switched to Custom sorting.', 'success', {
      text: 'Undo',
      callback: () => {
        currentSort = oldSortMode
        localStorage.setItem('maintainer_sort_mode', oldSortMode)
        if (oldCustomOrder) {
          localStorage.setItem(`maintainer_custom_order_${networkId}`, oldCustomOrder)
        } else {
          localStorage.removeItem(`maintainer_custom_order_${networkId}`)
        }
        const select2 = document.getElementById('sort-select')
        if (select2) select2.value = oldSortMode
        renderTable()
        showToast('Reverted sort changes.', 'success')
      }
    })
  }
  localStorage.setItem(`maintainer_custom_order_${networkId}`, JSON.stringify(rowLabels))
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

async function init() {
  try {
    networks = await fetchNetworks()
    if (networks === null) { showLogin(); return }
    networkId = networks[0] || 'main'
    await Promise.all([fetchTargets(), fetchStock(), fetchRegistry(), fetchSettings()])
    render()
    connectWs()
  } catch {
    app.innerHTML = `<p>${msg.serverDown}</p>`
  }
}

init()
