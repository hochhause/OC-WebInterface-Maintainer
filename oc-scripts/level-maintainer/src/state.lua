-- Local mirror of the last config the website pushed.
--
-- The web is the editor for the config, not the place it runs from: the
-- maintainer writes every accepted push here and loads it on boot. A prolonged
-- outage (or a connector that was never installed) therefore costs nothing --
-- schedules, groups and CPU limit keep running from this file.
--
-- Plain serialized Lua on purpose, so it can be hand-edited for a fully
-- serverless setup.

local serialization = require("serialization")
local filesystem = require("filesystem")

local state = {}

local PATH = "/home/maintainer-state.lua"

function state.path()
  return PATH
end

function state.load()
  if not filesystem.exists(PATH) then return nil end
  local file = io.open(PATH, "r")
  if not file then return nil end
  local text = file:read("*a")
  file:close()
  if not text or text == "" then return nil end
  local ok, data = pcall(serialization.unserialize, text)
  if not ok or type(data) ~= "table" then return nil end
  return data
end

function state.save(data)
  local ok, text = pcall(serialization.serialize, data, true)
  if not ok then return false, tostring(text) end
  local file, err = io.open(PATH, "w")
  if not file then return false, tostring(err) end
  file:write(text)
  file:close()
  return true
end

return state
