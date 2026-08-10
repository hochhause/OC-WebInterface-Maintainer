local component = require("component")
local event = require("event")
local internet = require("internet")
local serialization = require("serialization")
local json = require("json")
local cfg = require("config")

local tunnel = component.tunnel

local function log(msg)
  print("[" .. os.date("%H:%M:%S") .. "] " .. tostring(msg))
end

local function post(path, body)
  local url = cfg.server .. path
  local data = json.encode(body)
  local ok, result = pcall(function()
    local response = internet.request(url, data, {
      ["Content-Type"] = "application/json",
      ["Authorization"] = "Bearer " .. cfg.api_key,
    })
    local chunks = {}
    for chunk in response do chunks[#chunks + 1] = chunk end
    return table.concat(chunks)
  end)
  if not ok then
    log("http error: " .. tostring(result))
    return nil
  end
  local ok2, decoded = pcall(json.decode, result)
  if not ok2 then
    log("json error: " .. tostring(result))
    return nil
  end
  return decoded
end

local function ask(msg)
  tunnel.send(msg)
  local _, _, _, _, _, reply = event.pull(cfg.tunnel_timeout, "modem_message")
  if not reply then return nil end
  local data = serialization.unserialize(reply)
  return type(data) == "table" and data or nil
end

local function pushTargets(targets)
  tunnel.send(serialization.serialize({ targets = targets }))
end

local lastTargetsStr = nil
local lastSentSleep = nil

while true do
  local stockData = ask("requeststock")
  if not stockData then
    log("no response from maintainer")
    os.sleep(cfg.poll_interval)
  else
    local result = post("/api/sync", {
      network_id = cfg.network_id,
      stock = stockData.stock,
      status = stockData.status,
    })
    stockData = nil

    if result and result.targets then
      local targetStr = serialization.serialize(result.targets)
      if targetStr ~= lastTargetsStr then
        lastTargetsStr = targetStr
        pushTargets(result.targets)
        log("targets updated")
      end
      if result.maintainer_sleep and result.maintainer_sleep ~= lastSentSleep then
        lastSentSleep = result.maintainer_sleep
        tunnel.send("setsleep:" .. result.maintainer_sleep)
      end
    else
      log("sync failed")
    end

    os.sleep(cfg.poll_interval)
  end
end
