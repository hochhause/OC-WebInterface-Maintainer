local shell = require("shell")
local filesystem = require("filesystem")

local repo = "https://raw.githubusercontent.com/Soycakes/OC-WebInterface-Maintainer/main/oc-scripts/web-connector/"
local scripts = {"connector.lua", "json.lua"}

local function cwd(path)
  return shell.getWorkingDirectory() .. "/" .. path
end

for i = 1, #scripts do
  if filesystem.exists(cwd(scripts[i])) then
    filesystem.remove(cwd(scripts[i]))
  end
  shell.execute(string.format("wget %s%s %s", repo, scripts[i], scripts[i]))
end

if not filesystem.exists(cwd("config.lua")) then
  shell.execute(string.format("wget %sconfig.lua config.lua", repo))
end

shell.execute("reboot")
