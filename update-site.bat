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
echo Updated files:
echo %~dp0assets\data.js
echo %~dp0assets\app.js
echo %~dp0assets\loot-archive.json
echo.
echo Upload/replace assets\data.js, assets\app.js, and assets\loot-archive.json on GitHub.
echo.
start "" "%~dp0assets"
pause
