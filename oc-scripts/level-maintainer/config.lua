return {
  -- Default schedule: how often ungrouped items are checked, in game seconds.
  sleep = 10,
  debug = true,

  -- 0  = only the built-in floor (never submit into zero free crafting CPUs)
  -- 3  = never run more than 3 of our own jobs at once
  -- -2 = always leave 2 CPUs free for the players
  cpu_limit = 0,

  -- Only used until the website pushes a config: from then on the maintainer
  -- runs from /home/maintainer-state.lua and this table is ignored. Delete that
  -- file to come back to these values (serverless setups edit it directly).
  items = {
    ["Iron Plate"] = {nil, 16},
    -- ["Osmium Dust"] = {nil, 64},
    -- ["drop of Molten SpaceTime"] = {1000000, 1, "spacetime"},
    -- 4th slot puts the item in a group: {threshold, batch, fluid_tag, group_id}
    -- ["Certus Quartz Dust"] = {10000, 64, nil, 1},
  },

  fluids = {
    -- ["Steam"] = {1000000, 100000},
  },

  -- Groups referenced by the 4th slot above. interval_s gives the group its own
  -- schedule (game seconds); min_tps skips it while the server runs slower.
  groups = {
    -- [1] = { name = "Ores", interval_s = 600, min_tps = 18 },
  },
}
