# OC Level Maintainer Web App

A web interface for OpenComputers level maintainer in GregTech New Horizons modpack!  
Add and change items to stock on your AE2 network, see currrent stocked item counts through website & even remotely!

### **Currently only works for version 2.9 of GTNH**
(2.8 uses AE2FC which needs a bit of different handling ~~which I'm too lazy for~~)

> The OC maintainer script is based on [Echoloquate/Level-Maintainer](https://github.com/Echoloquate/Level-Maintainer),  
> which is forked from [Niels1006/Level-Maintainer](https://github.com/Niels1006/Level-Maintainer).

# Disclaimer
Your network key is the only thing protecting your AE2 network. Anyone who has it can change your maintained values. Don't paste it in a public Discord. I'm not responsible if you do.

---

## What it does

Set a target stock level for any craftable item or fluid, and an OC computer keeps
your AE2 network topped up to it. The website is where you set those targets and
watch what's happening.

- **Stock targets** — threshold + batch size per item, live counts, per-row status
  (stocked / crafting / failed / waiting), enable-disable without deleting.
- **Groups** — bracket rows together NEI-calculator style, collapse them, rename
  them, toggle a whole group at once.
- **Schedules** — a group can be checked on its own interval instead of every
  cycle. Ores every 10 minutes, hot stuff every 10 seconds.
- **CPU limit** — cap how many crafting CPUs the maintainer is allowed to occupy,
  or reserve some for the players.
- **Run now** — force a schedule to check immediately.
- **TPS gate** — hold a group back while the server is running slow, and see the
  measured TPS in the header.
- **One site, many networks** — every AE2 network is isolated behind its own key.
- **Keeps running without the website** — the maintainer remembers its config and
  carries on through outages, or with no web server at all.

## How it works

Two OC computers run ingame  
Web app runs on either local or on a server
  
One manages your AE2 system  
One connects it to the web server  

The **Maintainer** does all the AE2 work and holds the schedule. The **Connector**
just shuttles data between it and the website over a linked card. Nothing about
your crafting depends on the website staying up — the Maintainer keeps its own
copy of the config and runs from that.

### One website, many players

A single deployed web app serves any number of separate AE2 networks.

Each Connector computer holds a **network key**, generated for you when you install it.
That key does two jobs:

- the Connector uses it to talk to the server
- you type it into the website to log in

The key *is* the identity of your network. Network A and network B are fully isolated:
different targets, different stock, different live updates. The site never sees a
"user" — anyone holding your key sees your network, and nothing else does.

So one person can host the site and everyone else just points their Connector at it.

# Open Computers Setup
>**OpenComputers Linked Card**  
Craft 2 together to link them to same channel, then put each into both your **Maintainer** and **Connector** computers.

### Maintainer  
OC that runs the logic to actually maintain and send ae2 request  
> **This computer needs Adapter** touching main crafting network's ME Interface

To install, run
```
wget raw.githubusercontent.com/Soycakes/OC-WebInterface-Maintainer/main/oc-scripts/install-maintainer.lua && install-maintainer
```
then run `Maintainer` to run the program

### Connector  
OC that connects Maintainer to web app transferring needed data between  

> **This computer needs Internet Card.**  
> Also make sure Linked card (2x crafted together) is in BOTH this and the maintainer OC

To install, run
```
wget raw.githubusercontent.com/Soycakes/OC-WebInterface-Maintainer/main/oc-scripts/install-connector.lua && install-connector
```
The installer asks for your server URL and a name, then **generates your network key
and prints it**. Write it down — that's your website login. Running the installer
again keeps the same config and just prints the key back at you.

then run `Connector` to run the program

> **Updating from an older version: run both installers.** The two computers talk
> in a slightly different way now — big messages get split into pieces — and only
> the new scripts on both sides handle the largest target lists. The Maintainer
> installer now also pulls `src/chunk.lua`, `src/scheduler.lua` and `src/state.lua`
> alongside the scripts it always did.

---

## Web Server Setup

### No server (Local / Single player, Super Easy)  
Download the project here, then run Start.bat  
On first time running it only asks for a port (3000 is fine).

Open `http://localhost:3000` — on this machine you're let straight in, no key needed.

Settings live in `server/.env`, the database in `server/data/data.db`.

> Note - You may have to whitelist local address in OpenComputer's config. Configs -> OpenComputers.cfg  
> Find `filteringRules` inside and add `"allow ip:127.0.0.1",`

> `SINGLE_USER=true` in `server/.env` is what skips the login. It only applies to
> browsers on the same machine, but don't set it on anything reachable from the
> internet — remove it and log in with your network key instead.

### On a server (More choices, depends on what you want)

Both options below persist the database on a **named volume**, so redeploys and
image updates don't wipe everyone's targets. Do not skip that step.

### Option 1 - Railway ("One click" solution)

Railway hosts the server for you, using this repo directly.  
Free tier covers normal usage.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.com/deploy/ltSUYK?referralCode=sGOO6e)

1. Click the button above and sign in with GitHub
2. Deploy
3. **Add a volume.** Right-click the service canvas → *Add Volume* → mount path `/data`.
   Railway exposes it as `RAILWAY_VOLUME_MOUNT_PATH` and the server picks it up
   automatically. **Without this, every redeploy deletes the database.**
4. In Settings tab, scroll down to Networking, and click "Generate Domain". This is your URL for your website.
5. Give that URL to everyone who should connect. Each of them puts it in their
   Connector OC's config.lua (`edit config.lua`, set `server = "https://Railway-URL-Here",` then `Ctrl+S Ctrl+W`)
6. (Optional) in Variables tab, set `OPEN_REGISTRATION=false` once everyone's
   Connector has synced at least once. New keys are refused after that.

Keep replicas at 1 — the database is a single SQLite file.

---

### Option 2 - Docker / any VPS

```bash
git clone https://github.com/Soycakes/OC-WebInterface-Maintainer
cd OC-WebInterface-Maintainer
docker compose up -d
```

That's it. The database lives in the named volume `oc-maintainer-data`, mounted at
`/data` in the container, and survives `docker compose down`, rebuilds and updates.

Back it up with:
```bash
docker run --rm -v oc-maintainer-data:/data -v ${PWD}:/backup alpine \
  tar czf /backup/oc-maintainer-backup.tar.gz -C /data .
```

Put it behind a reverse proxy (Caddy/nginx) for HTTPS. OpenComputers' internet
card handles `https://` fine.

---

### Server settings

All optional, set in `server/.env` or your host's variables tab.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `.` | Where `data.db` is written. Point at your volume. `RAILWAY_VOLUME_MOUNT_PATH` is used automatically if set. |
| `OPEN_REGISTRATION` | `true` | `false` refuses api keys the server hasn't seen before, so no new networks can register |
| `RATE_LIMIT` | `60` | Max requests per minute per IP across all of `/api` (and websocket connects). `0` disables. Default fits a connector polling every 10s plus a browser with room to spare. |
| `BLOCKED_IPS` | unset | Comma-separated IPs that get `403` on everything. For when someone earns it. |
| `TRUST_PROXY` | unset | `true` = read visitor IPs from `X-Forwarded-For`. Needed behind Caddy/nginx so rate limits hit visitors, not the proxy. Automatic on Railway. |
| `SINGLE_USER` | unset | `true` = one network, no login for local browsers. Localhost only. |
| `API_KEY` | unset | Legacy single-tenant installs only — seeds the old `main` network so existing databases keep working |
| `BROWSER_PASSWORD` | unset | Legacy single-tenant installs only — still logs into the old `main` network |

---

### Open Computer Configs

**Connector.** `install-connector` writes this for you. You only need to touch it
to change the server URL or the display name.

```lua
return {
  server = "https://your-app.railway.app", -- your server URL
  api_key = "generated-by-the-installer",  -- your network key + website login
  name = "base",                           -- shown on the website
}
```

Lost your key? Run `install-connector` on the Connector computer again, or
`edit config.lua` and read it there.

To move a network to a different key, change `api_key` and restart the Connector —
it registers as a *new, empty* network. The old one keeps its data under the old key.

**Maintainer.** Its `config.lua` only matters until the website pushes a config for
the first time; after that the Maintainer runs from `/home/maintainer-state.lua`.
For a Maintainer with no Connector, this file is where you set everything:

```lua
return {
  sleep = 10,       -- default schedule, in game seconds
  cpu_limit = 0,    -- 0 off, 3 = max 3 own jobs, -2 = leave 2 CPUs for players
  debug = true,     -- shows query time and ME call count on the screen

  items = {
    ["Iron Plate"] = {nil, 16},                    -- {threshold, batch}
    ["Certus Quartz Dust"] = {10000, 64, nil, 1},  -- ...fluid tag, group id
  },
  fluids = {
    -- ["Steam"] = {1000000, 100000},
  },
  groups = {
    [1] = { name = "Ores", interval_s = 600, min_tps = 18 },
  },
}
```

A `nil` threshold means "always craft" — the maintainer requests a batch every
time that item isn't already being crafted.

---

## Using the site

### The table

One row per maintained item. Click the item slot to swap it for another,
`Threshold` is the level to keep it at, `Batch size` is how much to request at a
time. Both accept shorthand and arithmetic: `64k`, `1.5m`, `20*64`.

Row colour tells you where each item stands:

| Colour | Meaning |
|---|---|
| Green | Stocked, or a craft was just requested |
| Blue | Currently crafting |
| Amber | Wanted crafting, but no free CPU — retried next cycle |
| Red | The request failed (not craftable, missing pattern, no ingredients…) |
| Grey | Disabled |

The counts above the table summarise the same thing, and the header shows the
measured server TPS and how many crafting CPUs are busy.

### Groups

In sorting -> Custom, you can drag LEFT in the blank area left of the handle to
create bracket groups similar to NEI Calculator (literally click drag in those
areas like you would with NEI calculator groupping)

Bracket groups can be clicked to collapse then moved around and renamed.
(Enable/Disable on collapse group disables/enables all things in the group)
Right-click the bracket area to ungroup.

The UX for this isn't that good, so likely this will be reworked.

Groups and your row order are saved **on the server**, not in your browser, so the
Maintainer can act on them and everyone using your key sees the same layout. If you
had groups from an older version, they get uploaded automatically the first time
you open the site.

### Schedules

Below the table there's a row per schedule.

- **Default schedule** — everything that isn't in a group with its own interval.
  Its interval is the "Check every N s" box in the toolbar.
- **A group with an interval** — checked every N seconds instead. Good for slow
  bulk things: set a group of ores to 600s and the Maintainer stops asking your ME
  system about them every 10 seconds.
- **min TPS** — optional. That group is skipped while the server runs slower than
  the number you set. Leave it empty for off.
- **Run now** — checks that schedule immediately. Takes up to one Connector poll
  (~10s), so the button says "queued..." until the Maintainer confirms.

Seconds are *game* seconds. If the server is lagging at 10 TPS, a "600s" group is
checked every 20 real minutes — the same way your machines are running at half
speed. Nothing bursts or shifts after a server freeze either.

A collapsed group shows how long ago it was last checked. A 30-minute group
legitimately shows half-hour-old stock counts; that's what the label is for.

### CPU limit

Next to the check interval.

| Value | Meaning |
|---|---|
| `0` | No limit, but never submit a job when zero crafting CPUs are free |
| `3` | Never run more than 3 jobs of our own at once |
| `-2` | Always leave 2 CPUs free for players |

Items that wanted crafting but couldn't get a CPU show up amber as "waiting for
CPU" and are retried next cycle, instead of the wall of "failed to request" the
old version produced when the CPUs were all busy.

The limit is a courtesy, not a lock: it counts the jobs *this maintainer* started,
so a player submitting a craft by hand mid-cycle can still fill the last CPU.

---

## Running without the website

Every config the Maintainer accepts is written to `/home/maintainer-state.lua` and
loaded on boot, so a web outage — or no web server at all — doesn't stop your
crafting. It keeps running its full schedule from that file.

That makes **Maintainer-only** a supported setup: install just the Maintainer, skip
the Connector, and edit the config by hand. It's plain Lua:

```
edit /home/maintainer-state.lua
```

Delete that file to go back to `config.lua`. The Maintainer prints which of the two
it loaded when it starts.

TPS is the one thing that needs the website: an OC computer has no real-world
clock, so the server sends its own with each poll. Without a Connector the
Maintainer falls back to a local trick, and if that doesn't work on your setup the
header just shows no TPS and every `min TPS` gate stays open — a gate never stops
crafting on a number it isn't sure about.

---

## Troubleshooting

**Stock counts look old.** Check whether that item is in a group with a long
interval — collapsed group rows show "checked 23m ago". Hit Run now to force it.

**Everything is amber "waiting for CPU".** All your crafting CPUs are busy, or your
CPU limit is lower than the number of items that want crafting right now. Raise the
limit, or add CPUs.

**Rows are red saying "not craftable".** The Maintainer resolves items by label
against the patterns in your ME network. If there's no pattern, or the label
differs, it can't request it.

**The website shows nothing / "never synced".** The Connector isn't reaching the
server. Check the URL in its `config.lua`, that it has an Internet Card, and the
`filteringRules` note above for local hosting.

**"no response from maintainer" on the Connector.** The linked cards aren't a pair,
or the Maintainer program isn't running. Both computers need halves of the *same*
crafted pair.
