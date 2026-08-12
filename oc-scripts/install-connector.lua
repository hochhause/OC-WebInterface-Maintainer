local shell = require("shell")
local filesystem = require("filesystem")
local computer = require("computer")

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

local function generateKey()
  math.randomseed(math.floor((os.time() * 1000 + computer.uptime() * 1000) % 2147483647))
  for _ = 1, 8 do math.random() end
  local chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  local out = {}
  for i = 1, 32 do
    local n = math.random(#chars)
    out[i] = chars:sub(n, n)
  end
  return table.concat(out)
end

local function showKey(key)
  print("")
  print("======================================================")
  print(" Network key for this computer:")
  print("")
  print("   " .. key)
  print("")
  print(" Enter this on the website to see this AE2 network.")
  print(" Anyone holding it gets full access, so keep it to")
  print(" yourself. It stays saved here in config.lua.")
  print("======================================================")
  print("")
end

local function ask(prompt, fallback)
  io.write(prompt)
  local answer = io.read()
  if answer == nil or answer == "" then return fallback end
  return answer
end

if filesystem.exists(cwd("config.lua")) then
  local ok, cfg = pcall(dofile, cwd("config.lua"))
  if ok and type(cfg) == "table" and cfg.api_key and #cfg.api_key >= 16 then
    print("Keeping the existing config.lua.")
    showKey(cfg.api_key)
  end
else
  local server = ask("Server URL [http://127.0.0.1:3000]: ", "http://127.0.0.1:3000")
  local name = ask("Name for this network [base]: ", "base")
  local key = generateKey()

  local file = io.open(cwd("config.lua"), "w")
  file:write(string.format([[
return {
  server = "%s",

  -- Identifies this AE2 network to the server AND is your website login.
  api_key = "%s",

  -- Display name shown on the website.
  name = "%s",

  poll_interval = 10,
  tunnel_timeout = 8,
}
]], server, key, name))
  file:close()

  showKey(key)
end

print("Press Enter to reboot.")
io.read()
shell.execute("reboot")
