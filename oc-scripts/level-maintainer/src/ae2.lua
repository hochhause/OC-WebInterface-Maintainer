local component = require("component")
local computer = require("computer")
local ME = component.me_interface

local ae2 = {}

local itemCache = {}
local fluidNameCache = {}
local cacheTime = 0
local CACHE_TTL = 600

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
  local results = ME.getCraftables({ ["label"] = name })
  if #results >= 1 then
    itemCache[name] = results[1]
    return results[1]
  end
  itemCache[name] = false
  return nil
end

local function getStack(craftable)
  return (craftable.getStack or craftable.getItemStack)(craftable)
end

local function itemCount(craftable)
  local item = getStack(craftable)
  if not item or not item.name then return 0, nil end
  local found
  if item.tag then
    found = ME.getItemInNetwork(item.name, item.damage or 0, item.tag)
  end
  if not found then
    found = ME.getItemInNetwork(item.name, item.damage or 0)
  end
  return found and found.size or 0, item
end

function ae2.getCount(name, fluidName)
  if fluidName then
    local fluid = ME.getFluidInNetwork(fluidName)
    return fluid and (fluid.size or fluid.amount) or 0
  end
  local craftable = getCraftable(name)
  if not craftable then return 0 end
  return itemCount(craftable)
end

function ae2.requestItem(name, threshold, batch, fluidName, currentCount)
  local craftable = getCraftable(name)
  if not craftable then
    return false, name .. " is not craftable"
  end
  local itemStack
  if threshold ~= nil then
    local count
    if fluidName then
      local fluid = ME.getItemInNetwork("ae2fc:fluid_drop", 0, '{Fluid:' .. fluidName .. '}')
      count = fluid and fluid.size or 0
    else
      if currentCount then
        count = currentCount
      else
        count, itemStack = itemCount(craftable)
      end
    end
    if count >= threshold then return end
  end
  local item = itemStack or getStack(craftable)
  if item.label ~= name then
    return false, name .. " label mismatch"
  end
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
        local fluid = ME.getFluidInNetwork(fluidName)
        amount = fluid and (fluid.size or fluid.amount) or 0
      else
        amount = 0
      end
    end
    if amount >= threshold then return end
  end
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
  local fluid = ME.getFluidInNetwork(fluidName)
  return fluid and (fluid.size or fluid.amount) or 0
end

function ae2.crafting()
  local cpus = ME.getCpus()
  local active = {}
  for _, v in pairs(cpus) do
    local output = v.cpu.finalOutput()
    if output then active[output.label] = output.size or 1 end
  end
  return active
end

function ae2.hasFluidSupport()
  return ME.getFluidInNetwork ~= nil
end

function ae2.clearCache()
  itemCache = {}
  fluidNameCache = {}
  cacheTime = 0
end

return ae2
