# SoftRes Roller site

Free static website for `SoftResRoller.lua`.

## Open locally

Open `index.html` in a browser.

## Update data

Easy way: double-click `update-site.bat`.

Run this from PowerShell:

```powershell
.\update.ps1
```

The script reads:

```text
D:\Wow\World of Warcraft 3.3.5a\WTF\Account\ISUPERFRESH\SavedVariables\SoftResRoller.lua
```

and rewrites:

```text
assets\data.js
```

If the WoW file moves, pass a new path:

```powershell
.\update.ps1 -Source "D:\Path\To\SoftResRoller.lua"
```

## Free hosting

Upload this whole folder to GitHub Pages, Cloudflare Pages, or Netlify.
After each raid, run `update-site.bat`, then upload or push the changed `assets\data.js` file again.
