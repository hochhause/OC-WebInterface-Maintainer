local component = require("component")
local computer = require("computer")
local ME = component.me_interface

local ae2 = {}

local itemCache = {}
local fluidNameCache = {}
local cacheTime = 0
local CACHE_TTL = 600

local craftingCache = nil
local cpuCache = { total = 0, busy = 0 }
local craftingCacheTime = 0
local CRAFTING_CACHE_TTL = 30

local queryCount = 0

function ae2.getQueryCount()
  return queryCount
end

function ae2.resetQueryCount()
  queryCount = 0
end

local function getCraftable(name)
  local now = computer.uptime()
  if now - cacheTime >= CACHE_TTL then
    itemCache = {}
    fluidNameCache = {}
    cacheTime = now
  end
  local cached = itemCache[name]
  if cached ~= nil then
    return cached ~= false and cached or nil
  end
  queryCount = queryCount + 1
  local results = ME.getCraftables({ ["label"] = name })
  if #results >= 1 then
    itemCache[name] = results[1]
    return results[1]
  end
  itemCache[name] = false
  return nil
end

local function getStack(craftable)
  queryCount = queryCount + 1
  return (craftable.getStack or craftable.getItemStack)(craftable)
end

-- Thaumic Energistics essentia lives in its own AE2 storage channel, invisible
-- to getItemInNetwork. GTNH's OC fork exposes it via getEssentiaInNetwork
-- (absent on packs without TE -- everything here degrades to old behavior).
local function essentiaAmount(tag)
  if not ME.getEssentiaInNetwork then return nil end
  queryCount = queryCount + 1
  local ok, stack = pcall(ME.getEssentiaInNetwork, tag)
  if not ok then return nil end -- not a valid aspect tag
  return stack and (stack.amount or 0) or 0
end

-- Essentia stacks report {name=<aspect tag>, amount=N}; item stacks have .size.
local function isEssentiaStack(stack)
  return stack.amount ~= nil and stack.size == nil
end

local function itemCount(craftable)
  local item = getStack(craftable)
  if not item or not item.name then return 0, nil end
  if isEssentiaStack(item) then
    return essentiaAmount(item.name) or 0, item
  end
  local found
  if item.tag then
    queryCount = queryCount + 1
    found = ME.getItemInNetwork(item.name, item.damage or 0, item.tag)
  end
  if not found then
    queryCount = queryCount + 1
    found = ME.getItemInNetwork(item.name, item.damage or 0)
  end
  return found and found.size or 0, item
end

function ae2.getCount(name)
  local craftable = getCraftable(name)
  if craftable then return itemCount(craftable) end
  -- No craftable: still count stored essentia (aspect tag = lowercased label)
  local amount = essentiaAmount(name:lower())
  if amount then return amount end
  return 0
end

function ae2.requestItem(name, threshold, batch, currentCount)
  local craftable = getCraftable(name)
  if not craftable then
    return false, name .. " is not craftable"
  end
  local itemStack
  if threshold ~= nil then
    local count
    if currentCount then
      count = currentCount
    else
      count, itemStack = itemCount(craftable)
    end
    if count >= threshold then return end
  end
  local item = itemStack or getStack(craftable)
  -- Essentia matches by aspect tag; TE's localized label can differ from ours.
  if not item or (item.label ~= name and not (isEssentiaStack(item) and item.name == name:lower())) then
    return false, name .. " label mismatch or stack could not be resolved"
  end
  queryCount = queryCount + 1
  local craft = craftable.request(batch)
  while craft.isComputing() do os.sleep(1) end
  if craft.hasFailed() then
    return false, "failed to request " .. name .. " x " .. batch
  end
  return true, "requested " .. name .. " x " .. batch
end

function ae2.requestFluid(name, threshold, batch, fluidName, currentCount)
  local craftable = getCraftable(name)
  if not craftable then
    return false, name .. " is not craftable"
  end
  if threshold ~= nil then
    local amount
    if currentCount then
      amount = currentCount
    else
      if not fluidName then
        local cached = fluidNameCache[name]
        if cached == nil then
          local stack = getStack(craftable)
          cached = (stack and stack.name) or false
          fluidNameCache[name] = cached
        end
        if cached then fluidName = cached end
      end
      if fluidName then
        queryCount = queryCount + 1
        local fluid = ME.getFluidInNetwork(fluidName)
        amount = fluid and (fluid.size or fluid.amount) or 0
      else
        amount = 0
      end
    end
    if amount >= threshold then return end
  end
  queryCount = queryCount + 1
  local craft = craftable.request(batch)
  while craft.isComputing() do os.sleep(1) end
  if craft.hasFailed() then
    return false, "failed to request " .. name .. " x " .. batch .. " mB"
  end
  return true, "requested " .. name .. " x " .. batch .. " mB"
end

function ae2.getFluidCount(name, fluidName)
  if not fluidName then
    local cached = fluidNameCache[name]
    if cached == nil then
      local craftable = getCraftable(name)
      local stack = craftable and getStack(craftable)
      cached = (stack and stack.name) or false
      fluidNameCache[name] = cached
    end
    if cached then fluidName = cached end
  end
  if not fluidName then return 0 end
  queryCount = queryCount + 1
  local fluid = ME.getFluidInNetwork(fluidName)
  return fluid and (fluid.size or fluid.amount) or 0
end

-- Returns what the network is crafting, plus how many crafting CPUs exist and how
-- many are occupied. The CPU counts come free: the walk over getCpus() to find
-- the active jobs is the same walk that counts them.
function ae2.crafting()
  local now = computer.uptime()
  if not craftingCache or now - craftingCacheTime >= CRAFTING_CACHE_TTL then
    queryCount = queryCount + 1
    local cpus = ME.getCpus()
    local active = {}
    local total, busy = 0, 0
    for _, v in pairs(cpus) do
      queryCount = queryCount + 1
      total = total + 1
      local output = v.cpu.finalOutput()
      if output then
        busy = busy + 1
        -- item jobs report .size, essentia jobs report .amount
        active[output.label] = output.size or output.amount or 1
      end
    end
    craftingCache = active
    cpuCache = { total = total, busy = busy }
    craftingCacheTime = now
  end
  local copy = {}
  for k, v in pairs(craftingCache) do copy[k] = v end
  return copy, { total = cpuCache.total, busy = cpuCache.busy }
end

function ae2.clearCraftingCache()
  craftingCache = nil
  craftingCacheTime = 0
end

function ae2.hasFluidSupport()
  return ME.getFluidInNetwork ~= nil
end

function ae2.clearCache()
  itemCache = {}
  fluidNameCache = {}
  cacheTime = 0
  ae2.clearCraftingCache()
end

return ae2
