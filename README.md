# OC Level Maintainer Web App

A web interface for OpenComputers level maintainer in GregTech New Horizons modpack!  
Add and change items to stock on your AE2 network, see currrent stocked item counts through website & even remotely!

### **Currently only works for version 2.9 of GTNH**
(2.8 uses AE2FC which needs a bit of different handling ~~which I'm too lazy for~~)

> The OC maintainer script is based on [Echoloquate/Level-Maintainer](https://github.com/Echoloquate/Level-Maintainer),  
> which is forked from [Niels1006/Level-Maintainer](https://github.com/Niels1006/Level-Maintainer).

# Disclaimer
Regarding setting up server, everything should be completely safe as long as at minimum you set a browser key and some sort of API key string. I'm not responsible if you decide to share your link to public with no password, letting them change maintained values to weird values.

## How it works

Two OC computers run ingame  
Web app runs on either local or on a server
  
One manages your AE2 system  
One connects it to the web server  

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
then run `Connector` to run the program

---

## Web Server Setup

### No server (Local / Single player, Super Easy)  
Download the project here, then run Start.bat  
On first time running, you'll have an option to set :  
1. password (Not needed for local, leave blank)  
2. API key (also not needed, set anything)  
3. port  (3000 is fine for default)  

all of these can be changed later in `server/.env`

Open `http://localhost:3000`

> Note - You may have to whitelist local address in OpenComputer's config. Configs -> OpenComputers.cfg  
> Find `filteringRules` inside and add `"allow ip:127.0.0.1",`

### On a server (More choices, depends on what you want)

Pick one option based on your situation.

### Option 1 - Railway ("One click" solution)

Railway hosts the server for you, using this repo directly.  
Free tier covers normal usage.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.com/deploy/ltSUYK?referralCode=sGOO6e)

1. Click the button above and sign in with GitHub
2. Deploy
3. (Optional) in Variables tab, add `BROWSER_PASSWORD` (used as password for your website)
4. (Optional) in same place, add `API_KEY` (any string you choose, add this in Connector OC's config.lua)
5. In Settings tab, scroll down to Networking, and click "Generate Domain". This is your URL for your website.
6. Add the website URL in Connector OC's config.lua (type "edit config.lua", type in value `server = "https://Railway-URL-Here",` then `Ctrl+S Ctrl+W` to save&close)  
  
If any changes were made in 3,4 make sure to click Deploy in middle area of the page

---

### Option 2 - (WIP) Oracle Cloud Free Tier

Runs on VPS. More setup than Railway but no usage limits.

1. WIP, will fill in later

> **Other options:** You can also use any other VPS.

---

### Open Computer Configs

As said above, you need to change 'Connector' OC's config.lua

```lua
return {
  server = "https://your-app.railway.app", -- Railway server URL
  api_key = "your-api-key", -- Can be blank
  network_id = "main", -- Don't touch this, WIP
}
```

---

Actually using the site below here : WIP  
  
  In sorting -> Custom, you can drag LEFT in the blank area left of the handle to create bracket groups similar to NEI Calculator (literally click drag in those areas like you would with NEI calculator groupping)
    
  Bracket groups can be clicked to collapse then moved around and renamed. (Enable/Disable on collapse group disables/enables all things in the group)

  The UX for this isn't that good, so likely this will be reworked.
