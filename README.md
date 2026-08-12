# OC Level Maintainer Web App

A web interface for OpenComputers level maintainer in GregTech New Horizons modpack!  
Add and change items to stock on your AE2 network, see currrent stocked item counts through website & even remotely!

### **Currently only works for version 2.9 of GTNH**
(2.8 uses AE2FC which needs a bit of different handling ~~which I'm too lazy for~~)

> The OC maintainer script is based on [Echoloquate/Level-Maintainer](https://github.com/Echoloquate/Level-Maintainer),  
> which is forked from [Niels1006/Level-Maintainer](https://github.com/Niels1006/Level-Maintainer).

# Disclaimer
Your network key is the only thing protecting your AE2 network. Anyone who has it can change your maintained values. Don't paste it in a public Discord. I'm not responsible if you do.

## How it works

Two OC computers run ingame  
Web app runs on either local or on a server
  
One manages your AE2 system  
One connects it to the web server  

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
| `SINGLE_USER` | unset | `true` = one network, no login for local browsers. Localhost only. |
| `API_KEY` | unset | Legacy single-tenant installs only — seeds the old `main` network so existing databases keep working |
| `BROWSER_PASSWORD` | unset | Legacy single-tenant installs only — still logs into the old `main` network |

---

### Open Computer Configs

`install-connector` writes this for you. You only need to touch it to change the
server URL or the display name.

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

---

Actually using the site below here : WIP  
  
  In sorting -> Custom, you can drag LEFT in the blank area left of the handle to create bracket groups similar to NEI Calculator (literally click drag in those areas like you would with NEI calculator groupping)
    
  Bracket groups can be clicked to collapse then moved around and renamed. (Enable/Disable on collapse group disables/enables all things in the group)

  The UX for this isn't that good, so likely this will be reworked.
