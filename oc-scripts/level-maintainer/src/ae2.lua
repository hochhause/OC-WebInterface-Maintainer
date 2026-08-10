local component = require("component")
local computer = require("computer")
local ME = component.me_interface

local ae2 = {}

local itemCache = {}
local fluidNameCache = {}
local cacheTime = 0
local CACHE_TTL = 600

local craftingCache = nil
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

local function itemCount(craftable)
  local item = getStack(craftable)
  if not item or not item.name then return 0, nil end
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
  if not craftable then return 0 end
  return itemCount(craftable)
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
  if not item or item.label ~= name then
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

function ae2.crafting()
  local now = computer.uptime()
  if not craftingCache or now - craftingCacheTime >= CRAFTING_CACHE_TTL then
    queryCount = queryCount + 1
    local cpus = ME.getCpus()
    local active = {}
    for _, v in pairs(cpus) do
      queryCount = queryCount + 1
      local output = v.cpu.finalOutput()
      if output then active[output.label] = output.size or 1 end
    end
    craftingCache = active
    craftingCacheTime = now
  end
  local copy = {}
  for k, v in pairs(craftingCache) do copy[k] = v end
  return copy
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
