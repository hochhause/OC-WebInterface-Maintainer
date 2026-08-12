local component = require("component")
local computer = require("computer")
local event = require("event")
local internet = require("internet")
local serialization = require("serialization")
local json = require("json")
local chunk = require("chunk")
local cfg = require("config")

local tunnel = component.tunnel
local rx = chunk.receiver()

local function log(msg)
  print("[" .. os.date("%H:%M:%S") .. "] " .. tostring(msg))
end

if not cfg.api_key or #cfg.api_key < 16 then
  print("No api_key set in config.lua.")
  print("")
  print("The key identifies this AE2 network and is also your website login.")
  print("Run 'install-connector' to generate one, or edit config.lua and set")
  print("api_key to a random string of at least 16 characters.")
  return
end

local function post(path, body)
  local url = cfg.server .. path
  local data = json.encode(body)
  local ok, result = pcall(function()
    local response = internet.request(url, data, {
      ["Content-Type"] = "application/json",
      ["Authorization"] = "Bearer " .. cfg.api_key,
    })
    local parts = {}
    for part in response do parts[#parts + 1] = part end
    return table.concat(parts)
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

-- The stock reply no longer fits one linked-card packet on a large network, so it
-- can arrive as several frames. Keep reading until the message is whole.
local function ask(msg)
  tunnel.send(msg)
  local deadline = computer.uptime() + cfg.tunnel_timeout
  while true do
    local remaining = deadline - computer.uptime()
    if remaining <= 0 then return nil end
    local _, _, _, _, _, reply = event.pull(remaining, "modem_message")
    if not reply then return nil end
    local payload = chunk.feed(rx, reply)
    if payload then
      local ok, data = pcall(serialization.unserialize, payload)
      if ok and type(data) == "table" then return data end
      return nil
    end
  end
end

local lastConfigStr = nil

while true do
  local stockData = ask("requeststock")
  if not stockData then
    log("no response from maintainer")
    os.sleep(cfg.poll_interval)
  else
    -- No network id is sent: the server derives it from the api_key alone.
    local result = post("/api/sync", {
      name = cfg.name,
      stock = stockData.stock,
      status = stockData.status,
    })
    stockData = nil

    if result and result.error then
      log("server rejected: " .. tostring(result.error))
    elseif result and result.targets then
      -- One payload for everything the maintainer runs on: targets, groups and
      -- their schedules, the CPU limit, the default interval and the run-now
      -- counters. Pushed only when it changes; a changed counter is what a
      -- pressed Run now button looks like from here.
      local payload = {
        targets = result.targets,
        groups = result.groups,
        cpu_limit = result.cpu_limit,
        default_run_seq = result.default_run_seq,
        sleep = result.maintainer_sleep,
      }
      local configStr = serialization.serialize(payload)
      if configStr ~= lastConfigStr then
        lastConfigStr = configStr
        chunk.send(tunnel, configStr)
        log("config pushed")
      end

      -- Relay the server's wall clock. It is the only real time source the
      -- maintainer can reach, and it measures TPS against it.
      if type(result.now) == "number" then
        tunnel.send("now:" .. string.format("%.0f", result.now))
      end
    else
      log("sync failed")
    end

    os.sleep(cfg.poll_interval)
  end
end
