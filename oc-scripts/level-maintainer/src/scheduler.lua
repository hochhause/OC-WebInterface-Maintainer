-- Clock and TPS measurement for the per-group schedules.
--
-- The schedule clock is computer.uptime(), read in ticks. OC documents uptime as
-- "measured based on the world time that passed", so it advances 20 units per
-- second of *server ticks*, not of real time. That is exactly what a crafting
-- schedule wants:
--   * a lagging server stretches the schedule the same way it stretches the
--     machines the schedule is feeding,
--   * a frozen server advances it not at all, so recovery brings no overdue
--     burst and no permanent shift,
--   * and unlike the world clock it cannot be dragged around by /time set, by
--     players sleeping through the night, or frozen by doDaylightCycle false.
--
-- Measuring TPS is the one job that needs a real clock, and an OC computer has
-- none: every clock it can read is world time, which by definition ticks at 20
-- per second. So real time comes from outside -- the web server stamps each sync
-- response, the connector forwards it -- with a file-modification-time probe as
-- the fallback for a maintainer running with no connector at all. If neither is
-- available TPS reads nil and every TPS gate stays open.

local computer = require("computer")
local filesystem = require("filesystem")

local scheduler = {}

local WINDOW = 6          -- samples kept; at a 10s loop that is about a minute
local SERVER_TTL = 120    -- game seconds a server timestamp counts as current
local PROBE = "/tmp/.maintainer-clock"

local samples = {}
local probeWorks = true
local lastGame, lastReal = nil, nil
local serverSeenAt = nil
local source = nil

-- Game ticks since this computer booted. Monotonic; resets on reboot, which just
-- makes every schedule due once.
function scheduler.ticks()
  return computer.uptime() * 20
end

-- Real seconds from the host's own clock. OC hands out a real-world modification
-- timestamp for files, so writing one byte and reading its stamp back is a real
-- clock -- the only one available without a web server.
local function probeRealSeconds()
  if not probeWorks or type(filesystem.lastModified) ~= "function" then return nil end
  local file = io.open(PROBE, "w")
  if not file then
    probeWorks = false
    return nil
  end
  file:write("t")
  file:close()
  local ok, stamp = pcall(filesystem.lastModified, PROBE)
  if not ok or type(stamp) ~= "number" or stamp <= 0 then
    probeWorks = false
    return nil
  end
  -- Milliseconds everywhere we have looked, but accept seconds rather than
  -- reporting a TPS that is off by a factor of a thousand.
  if stamp > 1e11 then return stamp / 1000 end
  return stamp
end

local function record(game, real, from)
  if lastGame and lastReal then
    local gameDelta = game - lastGame
    local realDelta = real - lastReal
    -- Drop the pair when either clock did something a clock should not do
    -- (backwards, or a gap so large the sample says nothing about now).
    if gameDelta > 0 and realDelta > 0.05 and realDelta < 600 then
      samples[#samples + 1] = { game = gameDelta, real = realDelta }
      if #samples > WINDOW then table.remove(samples, 1) end
    end
  end
  lastGame, lastReal, source = game, real, from
end

-- Feeds an authoritative real-world timestamp (seconds) in. The web server puts
-- one in every sync response for exactly this.
function scheduler.feedRealTime(seconds)
  if type(seconds) ~= "number" or seconds <= 0 then return end
  local now = computer.uptime()
  if source ~= "server" then
    -- Switching clocks mid-window would compare a stamp against the other
    -- clock's epoch, so start the window over.
    samples = {}
    lastGame, lastReal = nil, nil
  end
  serverSeenAt = now
  record(now, seconds, "server")
end

-- Called once per maintainer loop. Only probes locally while no server timestamp
-- has arrived recently, so the accurate source wins when both exist.
function scheduler.sample()
  local now = computer.uptime()
  if serverSeenAt and now - serverSeenAt <= SERVER_TTL then return end
  if source == "server" then
    samples = {}
    lastGame, lastReal = nil, nil
    source = nil
  end
  local real = probeRealSeconds()
  if not real then return end
  record(now, real, "probe")
end

-- Ticks per second over the window, or nil when there is no real clock to
-- compare against yet. Callers treat nil as "unknown", never as "slow".
function scheduler.tps()
  if #samples < 2 then return nil end
  local game, real = 0, 0
  for _, s in ipairs(samples) do
    game = game + s.game
    real = real + s.real
  end
  if real <= 0 then return nil end
  local tps = game * 20 / real
  if tps < 0 then tps = 0 end
  if tps > 20 then tps = 20 end
  return math.floor(tps * 10 + 0.5) / 10
end

-- "server", "probe" or nil -- shown on the maintainer's screen so a wrong-looking
-- TPS can be traced to where it came from.
function scheduler.clockSource()
  return source
end

return scheduler
