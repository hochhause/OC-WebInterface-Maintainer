local component = require("component")
local computer = require("computer")
local event = require("event")
local serialization = require("serialization")
local ae2 = require("src.ae2")
local cfg = require("config")

local tunnel = component.tunnel

local items = cfg.items or {}
local fluids = cfg.fluids or {}
local currentSleep = cfg.sleep or 5

if fluids and next(fluids) and not ae2.hasFluidSupport() then
  print("WARNING: fluids configured but ME interface does not support getFluidInNetwork (needs GTNH 2.9+). Fluids skipped.")
  fluids = {}
end

local lastCycleStatus = { crafting = {}, requested = {}, failed = {} }
local cachedStock = {}

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

local function drawScreen(active, requested, failed)
  if not gpu then return end
  gpu.fill(1, 1, screenW, screenH, " ")
  local row = 1
  local function line(text, color)
    if row > screenH then return end
    gpu.setForeground(color or 0xFFFFFF)
    gpu.set(1, row, text)
    row = row + 1
  end
  local managedCrafting = false
  for label, count in pairs(active) do
    if items[label] or fluids[label] then
      if not managedCrafting then
        line("CURRENTLY CRAFTING", 0x55FFFF)
        managedCrafting = true
      end
      line("  " .. label .. " : " .. count .. "x", 0x55FFFF)
    end
  end
  if managedCrafting then line("---", 0x555555) end
  for label, batch in pairs(requested) do
    line("  requested " .. label .. " x " .. batch, 0x55FF55)
  end
  for _, msg in pairs(failed) do
    line("  " .. msg, 0xFF5555)
  end
  for _, entry in ipairs(logBuffer) do
    line(entry, 0x888888)
  end
  gpu.setForeground(0xFFFFFF)
end


local function stock()
  local counts = {}
  for label, config in pairs(items) do
    counts[label] = ae2.getCount(label, config[3])
  end
  for label, config in pairs(fluids) do
    counts[label] = ae2.getFluidCount(label, config[3])
  end
  return counts
end

local function handleModem(_, _, _, _, _, msg)
  if msg == "requeststock" then
    tunnel.send(serialization.serialize({ stock = cachedStock, status = lastCycleStatus }))
    return
  end
if msg:sub(1, 8) == "setsleep" then
    local n = tonumber(msg:sub(10))
    if n and n >= 1 then
      currentSleep = n
      log("sleep set to " .. n .. "s")
    end
    return
  end
  local data = serialization.unserialize(msg)
  if type(data) ~= "table" or not data.targets then return end
  items = {}
  fluids = {}
  for _, t in ipairs(data.targets) do
    if t.is_fluid == 1 then
      fluids[t.label] = { t.threshold, t.batch_size, t.fluid_tag }
    else
      items[t.label] = { t.threshold, t.batch_size, t.fluid_tag }
    end
  end
  ae2.clearCache()
  log("targets updated from web")
end

local function mainLoop()
  cachedStock = stock()
  event.listen("modem_message", handleModem)
  while true do
    os.sleep(currentSleep)

    cachedStock = stock()
    local active = ae2.crafting()
    local cycleRequested = {}
    local cycleFailed = {}

    for label, config in pairs(items) do
      if not active[label] then
        local ok, msg = ae2.requestItem(label, config[1], config[2], config[3], cachedStock[label])
        if ok then
          cycleRequested[label] = config[2] or 1
        elseif msg then
          cycleFailed[label] = msg
          log(msg)
        end
      end
    end

    for label, config in pairs(fluids) do
      if not active[label] then
        local ok, msg = ae2.requestFluid(label, config[1], config[2], config[3], cachedStock[label])
        if ok then
          cycleRequested[label] = config[2] or 1
        elseif msg then
          cycleFailed[label] = msg
          log(msg)
        end
      end
    end

    local managedActive = {}
    for label, count in pairs(active) do
      if items[label] or fluids[label] then managedActive[label] = count end
    end
    lastCycleStatus = { crafting = managedActive, requested = cycleRequested, failed = cycleFailed }
    drawScreen(active, cycleRequested, cycleFailed)
    logBuffer = {}
  end
end

local ok, err = pcall(mainLoop)
event.ignore("modem_message", handleModem)
if not ok then
  print("Stopped: " .. tostring(err))
end
