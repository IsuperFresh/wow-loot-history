@echo off
setlocal

title Update Award of Light loot site
cd /d "%~dp0"

echo Updating site data from WoW SoftResRoller.lua...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
if errorlevel 1 (
  echo.
  echo Update failed. Check the error above.
  pause
  exit /b 1
)

echo.
echo Done.
echo Updated file:
echo %~dp0assets\data.js
echo.
echo Upload/replace assets\data.js on GitHub, then wait 1-2 minutes and press Ctrl+F5 on the site.
echo.
start "" "%~dp0assets"
pause
