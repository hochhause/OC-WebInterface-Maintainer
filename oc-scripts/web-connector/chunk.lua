-- Splits oversized linked-card messages into frames and reassembles them.
--
-- A tunnel message has to fit OpenComputers' maxNetworkPacketSize (8192 bytes by
-- default). Both directions had outgrown that: the config push now carries groups
-- and schedules on top of the targets, and the stock reply carries a count plus a
-- status entry for every managed item.
--
-- Payloads that still fit are sent unframed, so a computer running the older
-- script on the other end of the link keeps working exactly as before.
--
-- Mirrored between level-maintainer/src/chunk.lua and web-connector/chunk.lua
-- (each computer downloads only from its own folder) -- keep the two identical.

local computer = require("computer")

local chunk = {}

local PAYLOAD = 4000  -- bytes per frame, comfortably under the packet cap
local STALE = 30      -- seconds before a half-received message is abandoned

local nextId = 0

function chunk.send(tunnel, payload)
  if #payload <= PAYLOAD then
    tunnel.send(payload)
    return 1
  end
  nextId = (nextId % 4096) + 1
  local total = math.ceil(#payload / PAYLOAD)
  for i = 1, total do
    tunnel.send(string.format("c|%d|%d|%d|%s", nextId, i, total,
      payload:sub((i - 1) * PAYLOAD + 1, i * PAYLOAD)))
  end
  return total
end

function chunk.receiver()
  return {}
end

-- Feeds one raw tunnel message in. Returns the complete payload when the message
-- is whole, nil while frames are still missing. Anything that is not a frame is
-- returned as-is, which is what keeps plain commands and unframed payloads working.
function chunk.feed(rx, msg)
  if type(msg) ~= "string" then return nil end
  local id, index, total, body = msg:match("^c|(%d+)|(%d+)|(%d+)|(.*)$")
  if not id then return msg end

  id, index, total = tonumber(id), tonumber(index), tonumber(total)
  if not id or not index or not total then return nil end
  if index < 1 or index > total then return nil end

  local now = computer.uptime()
  for key, entry in pairs(rx) do
    if now - entry.at > STALE then rx[key] = nil end
  end

  local entry = rx[id]
  if not entry or entry.total ~= total then
    entry = { total = total, count = 0, parts = {}, at = now }
    rx[id] = entry
  end
  entry.at = now
  if entry.parts[index] == nil then
    entry.parts[index] = body
    entry.count = entry.count + 1
  end
  if entry.count < total then return nil end

  rx[id] = nil
  return table.concat(entry.parts)
end

return chunk
