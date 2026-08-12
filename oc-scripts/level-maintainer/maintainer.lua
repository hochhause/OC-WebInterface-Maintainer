local component = require("component")
local computer = require("computer")
local event = require("event")
local serialization = require("serialization")
local ae2 = require("src.ae2")
local chunk = require("src.chunk")
local scheduler = require("src.scheduler")
local state = require("src.state")
local cfg = require("config")

local tunnel = component.tunnel

-- Schedule keys are group ids, plus this one for "everything else": ungrouped
-- items and the members of groups that never set their own interval.
local DEFAULT_SCHEDULE = 0

local items = {}    -- label -> { threshold, batch, tag, group }
local fluids = {}   -- same shape
local groups = {}   -- id -> { name, interval_s, min_tps, run_seq }
local cpuLimit = 0
local currentSleep = cfg.sleep or 10
local debugEnabled = cfg.debug == true

local nextRun = {}     -- schedule key -> game ticks at which it is due again
local checkedAt = {}   -- schedule key -> uptime of its last check
local lastDefaultSeq = nil
local lastGroupSeq = {}
local rx = chunk.receiver()

-- Per-item outcome of the last time that item was actually checked. Sticky on
-- purpose: with a 30 minute group, a failure has to survive the default
-- schedule's cycles in between or it would blink out of the website.
local stCrafting = {}
local stRequested = {}
local stFailed = {}
local stWaiting = {}

local cachedStock = {}
local serializedStockCache = ""
local lastCpus = { total = 0, busy = 0 }
local lastQueryTime = nil
local lastQueryCount = nil

local gpu = component.isAvailable("gpu") and component.gpu or nil
local screenW, screenH = 50, 16
if gpu then screenW, screenH = gpu.getResolution() end

local logBuffer = {}

local function log(msg)
  local line = "[" .. os.date("%H:%M:%S") .. "] " .. tostring(msg)
  if gpu then
    logBuffer[#logBuffer + 1] = line
    if #logBuffer > 6 then table.remove(logBuffer, 1) end
  else
    print(line)
  end
end

local function drawScreen()
  if not gpu then return end
  gpu.fill(1, 1, screenW, screenH, " ")
  local row = 1
  local maxRow = screenH - 1
  local function line(text, color)
    if row > maxRow then return end
    gpu.setForeground(color or 0xFFFFFF)
    gpu.set(1, row, text)
    row = row + 1
  end

  local anyCrafting = false
  for label, count in pairs(stCrafting) do
    if not anyCrafting then
      line("CURRENTLY CRAFTING", 0x55FFFF)
      anyCrafting = true
    end
    line("  " .. label .. " : " .. count .. "x", 0x55FFFF)
  end
  if anyCrafting then line("---", 0x555555) end
  for label, batch in pairs(stRequested) do
    line("  requested " .. label .. " x " .. batch, 0x55FF55)
  end
  for label in pairs(stWaiting) do
    line("  no free CPU for " .. label, 0xFFAA00)
  end
  for _, message in pairs(stFailed) do
    line("  " .. message, 0xFF2020)
  end
  for _, entry in ipairs(logBuffer) do
    line(entry, 0x888888)
  end

  gpu.setForeground(0x777777)
  local parts = { os.date("%H:%M:%S") }
  if lastCpus.total > 0 then
    parts[#parts + 1] = "CPU " .. lastCpus.busy .. "/" .. lastCpus.total
  end
  if cpuLimit ~= 0 then
    parts[#parts + 1] = "limit " .. cpuLimit
  end
  local tps = scheduler.tps()
  if tps then
    parts[#parts + 1] = string.format("%.1f TPS (%s)", tps, scheduler.clockSource() or "?")
  end
  if lastQueryTime then
    local ticks = math.floor(lastQueryTime / 0.05 + 0.5)
    parts[#parts + 1] = string.format("Query %.2fs (%dt)", lastQueryTime, ticks)
    if lastQueryCount then parts[#parts + 1] = lastQueryCount .. " ME calls" end
  end
  gpu.set(1, screenH, table.concat(parts, "  "))
  gpu.setForeground(0xFFFFFF)
end

local function scheduleKey(entry)
  local group = entry.group and groups[entry.group]
  if group and group.interval_s then return entry.group end
  return DEFAULT_SCHEDULE
end

local function intervalTicks(key)
  local seconds = currentSleep
  if key ~= DEFAULT_SCHEDULE then
    local group = groups[key]
    seconds = (group and group.interval_s) or currentSleep
  end
  if seconds < 1 then seconds = 1 end
  return seconds * 20
end

-- A group can ask not to be run while the server is struggling. Unknown TPS
-- (no real clock available) counts as open: a guess must never stop crafting.
local function gateOpen(groupId)
  local group = groupId and groups[groupId]
  if not group or not group.min_tps then return true end
  local tps = scheduler.tps()
  if not tps then return true end
  return tps >= group.min_tps
end

local function forget(label)
  stRequested[label] = nil
  stFailed[label] = nil
  stWaiting[label] = nil
  stCrafting[label] = nil
  cachedStock[label] = nil
end

-- Applies one config payload: the blob the website pushes, the state file written
-- from the last such push, or config.lua converted into the same shape.
local function applyConfig(data, persist)
  local newItems, newFluids = {}, {}
  for _, t in ipairs(data.targets or {}) do
    if type(t.label) == "string" then
      local entry = {
        threshold = t.threshold,
        batch = t.batch_size or 1,
        tag = t.fluid_tag,
        group = t.group_id
      }
      if t.is_fluid == 1 or t.is_fluid == true then
        newFluids[t.label] = entry
      else
        newItems[t.label] = entry
      end
    end
  end

  if next(newFluids) and not ae2.hasFluidSupport() then
    log("fluids skipped: ME interface has no getFluidInNetwork (needs GTNH 2.9+)")
    newFluids = {}
  end

  items, fluids = newItems, newFluids

  groups = {}
  for _, g in ipairs(data.groups or {}) do
    if type(g.id) == "number" then
      groups[g.id] = {
        name = g.name,
        interval_s = g.interval_s,
        min_tps = g.min_tps,
        run_seq = g.run_seq or 0
      }
    end
  end

  if type(data.cpu_limit) == "number" then cpuLimit = math.floor(data.cpu_limit) end
  if type(data.sleep) == "number" and data.sleep >= 5 then currentSleep = math.floor(data.sleep) end

  -- Run-now is a counter, not a command: a value that changed since the last
  -- payload means somebody pressed the button, so that schedule is due now. A
  -- counter seen for the first time (first payload, or after a reboot) only gets
  -- remembered -- everything is due right after boot anyway.
  local now = scheduler.ticks()
  if type(data.default_run_seq) == "number" then
    if lastDefaultSeq and data.default_run_seq ~= lastDefaultSeq then
      nextRun[DEFAULT_SCHEDULE] = now
      log("run now: default schedule")
    end
    lastDefaultSeq = data.default_run_seq
  end
  for id, group in pairs(groups) do
    local seq = group.run_seq
    if lastGroupSeq[id] and seq ~= lastGroupSeq[id] then
      -- A group without its own interval runs inside the default schedule, so
      -- that is the timer its button has to move.
      nextRun[group.interval_s and id or DEFAULT_SCHEDULE] = now
      log("run now: " .. tostring(group.name or id))
    end
    lastGroupSeq[id] = seq
  end

  -- Drop bookkeeping for groups and items that no longer exist, or the website
  -- would keep seeing stock and check ages for things that are gone.
  for key in pairs(nextRun) do
    if key ~= DEFAULT_SCHEDULE and not groups[key] then nextRun[key] = nil end
  end
  for key in pairs(checkedAt) do
    if key ~= DEFAULT_SCHEDULE and not groups[key] then checkedAt[key] = nil end
  end
  for id in pairs(lastGroupSeq) do
    if not groups[id] then lastGroupSeq[id] = nil end
  end
  for label in pairs(cachedStock) do
    if not items[label] and not fluids[label] then forget(label) end
  end
  for label in pairs(stFailed) do
    if not items[label] and not fluids[label] then forget(label) end
  end

  ae2.clearCache()

  if persist then
    local ok, err = state.save(data)
    if not ok then log("could not write state file: " .. tostring(err)) end
  end
end

local function seedFromConfig()
  local targets = {}
  local function add(map, isFluid)
    for label, e in pairs(map or {}) do
      targets[#targets + 1] = {
        label = label,
        threshold = e.threshold or e[1],
        batch_size = e.batch or e[2] or 1,
        fluid_tag = e.tag or e[3],
        is_fluid = isFluid and 1 or 0,
        group_id = e.group or e[4]
      }
    end
  end
  add(cfg.items, false)
  add(cfg.fluids, true)

  local groupList = {}
  for id, g in pairs(cfg.groups or {}) do
    groupList[#groupList + 1] = {
      id = id,
      name = g.name,
      interval_s = g.interval_s,
      min_tps = g.min_tps,
      run_seq = 0
    }
  end

  return {
    targets = targets,
    groups = groupList,
    cpu_limit = cfg.cpu_limit or 0,
    sleep = cfg.sleep or 10
  }
end

local function refreshStatusCache()
  local now = computer.uptime()
  -- String keys: the connector encodes this as JSON, and a table whose keys are
  -- group ids would come out as an array with the default schedule's 0 dropped.
  local checked = {}
  for key, at in pairs(checkedAt) do
    checked[tostring(key)] = math.floor(now - at)
  end

  local status = {
    crafting = stCrafting,
    requested = stRequested,
    failed = stFailed,
    waiting_cpu = stWaiting,
    cpus = { total = lastCpus.total, busy = lastCpus.busy },
    group_checked = checked
  }
  local tps = scheduler.tps()
  if tps then status.tps = tps end

  serializedStockCache = serialization.serialize({ stock = cachedStock, status = status })
end

local function handleModem(_, _, _, _, _, message)
  if type(message) ~= "string" then return end

  if message == "requeststock" then
    chunk.send(tunnel, serializedStockCache)
    return
  end

  -- The one real-world clock reachable from in-game: the web server's, relayed
  -- by the connector on every poll. Feeds the TPS measurement, nothing else.
  if message:sub(1, 4) == "now:" then
    local ms = tonumber(message:sub(5))
    if ms then scheduler.feedRealTime(ms / 1000) end
    return
  end

  -- Older connectors sent the sleep interval on its own; newer ones put it in
  -- the config payload.
  if message:sub(1, 8) == "setsleep" then
    local n = tonumber(message:sub(10))
    if n and n >= 5 then
      currentSleep = math.floor(n)
      log("sleep set to " .. currentSleep .. "s")
    end
    return
  end

  local payload = chunk.feed(rx, message)
  if not payload then return end
  local ok, data = pcall(serialization.unserialize, payload)
  if not ok or type(data) ~= "table" or not data.targets then return end
  applyConfig(data, true)
  log("config updated from web")
end

-- One pass over everything the due schedules cover.
local function runCycle(dueSchedules)
  if debugEnabled then ae2.resetQueryCount() end
  local startTime = computer.uptime()

  -- Fresh CPU read, deliberately ignoring the 30s cache: the job budget for this
  -- cycle is decided from the state of the network right now.
  ae2.clearCraftingCache()
  local active, cpus = ae2.crafting()
  lastCpus = cpus

  local pending = {}
  for label, entry in pairs(items) do
    if dueSchedules[scheduleKey(entry)] and gateOpen(entry.group) then
      pending[label] = { entry = entry, fluid = false }
    end
  end
  for label, entry in pairs(fluids) do
    if dueSchedules[scheduleKey(entry)] and gateOpen(entry.group) then
      pending[label] = { entry = entry, fluid = true }
    end
  end

  for label, item in pairs(pending) do
    if item.fluid then
      cachedStock[label] = ae2.getFluidCount(label, item.entry.tag)
    else
      cachedStock[label] = ae2.getCount(label)
    end
    stRequested[label] = nil
    stFailed[label] = nil
    stWaiting[label] = nil
  end

  local managed = 0
  for label in pairs(active) do
    if items[label] or fluids[label] then managed = managed + 1 end
  end

  -- Never submit into zero free CPUs -- that is what used to produce a screen
  -- full of "failed to request". Anything that cannot get one is simply deferred
  -- to the next cycle and reported as waiting.
  local budget
  if cpus.total <= 0 then
    budget = math.huge  -- interface reports no CPUs at all: nothing to reason with
  else
    budget = cpus.total - cpus.busy
  end
  if cpuLimit > 0 then
    budget = math.min(budget, cpuLimit - managed)
  elseif cpuLimit < 0 and cpus.total > 0 then
    budget = math.min(budget, (cpus.total - cpus.busy) + cpuLimit)
  end
  if budget < 0 then budget = 0 end

  for label, item in pairs(pending) do
    if not active[label] then
      local entry = item.entry
      local count = cachedStock[label] or 0
      if entry.threshold == nil or count < entry.threshold then
        if budget < 1 then
          stWaiting[label] = "waiting for a free CPU"
        else
          local ok, message
          if item.fluid then
            ok, message = ae2.requestFluid(label, entry.threshold, entry.batch, entry.tag, count)
          else
            ok, message = ae2.requestItem(label, entry.threshold, entry.batch, count)
          end
          if ok then
            stRequested[label] = entry.batch or 1
            budget = budget - 1
          elseif message then
            stFailed[label] = message
          end
        end
      end
    end
  end

  stCrafting = {}
  for label, count in pairs(active) do
    if items[label] or fluids[label] then stCrafting[label] = count end
  end

  local at = computer.uptime()
  local now = scheduler.ticks()
  for key in pairs(dueSchedules) do
    checkedAt[key] = at
    nextRun[key] = now + intervalTicks(key)
  end

  lastQueryTime = debugEnabled and (computer.uptime() - startTime) or nil
  lastQueryCount = debugEnabled and ae2.getQueryCount() or nil
end

-- How long to wait before looking again: until the next schedule is due, but
-- never longer than one sleep interval, so a run-now that arrives mid-wait is
-- picked up promptly and the website keeps getting fresh status.
local function waitSeconds()
  local now = scheduler.ticks()
  local soonest = nextRun[DEFAULT_SCHEDULE] or 0
  for id, group in pairs(groups) do
    -- A group held back by its TPS gate is overdue by definition; counting it
    -- would spin the loop at the floor for as long as the server is slow.
    if group.interval_s and gateOpen(id) then
      local at = nextRun[id] or 0
      if at < soonest then soonest = at end
    end
  end
  local seconds = (soonest - now) / 20
  if seconds < 1 then seconds = 1 end
  if seconds > currentSleep then seconds = currentSleep end
  return seconds
end

local function mainLoop()
  refreshStatusCache()
  event.listen("modem_message", handleModem)
  while true do
    scheduler.sample()

    local now = scheduler.ticks()
    local dueSchedules = {}
    local anyDue = false
    if now >= (nextRun[DEFAULT_SCHEDULE] or 0) then
      dueSchedules[DEFAULT_SCHEDULE] = true
      anyDue = true
    end
    for id, group in pairs(groups) do
      if group.interval_s and now >= (nextRun[id] or 0) and gateOpen(id) then
        dueSchedules[id] = true
        anyDue = true
      end
    end

    -- Every AE2 call in this program happens here, so a timer coming due during
    -- a heavy cycle waits for the next iteration by construction.
    if anyDue then runCycle(dueSchedules) end

    refreshStatusCache()
    drawScreen()
    logBuffer = {}

    -- event.pull rather than os.sleep: a config push (which is how run-now
    -- arrives) wakes the loop instead of waiting out the rest of the interval.
    event.pull(waitSeconds(), "modem_message")
  end
end

local saved = state.load()
if saved then
  applyConfig(saved, false)
  print("Loaded config from " .. state.path() .. " (delete it to fall back to config.lua).")
else
  applyConfig(seedFromConfig(), false)
end

local ok, err = pcall(mainLoop)
event.ignore("modem_message", handleModem)
if not ok then
  print("Stopped: " .. tostring(err))
end
