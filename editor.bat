@echo off
rem Starts the asset editor and opens it in your web browser. Keep this window open while you use it.
rem No administrator rights needed: the editor only reads the game files.
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed. Opening https://nodejs.org - install the LTS version, then run this again.
  start "" https://nodejs.org
  pause
  exit /b 1
)
node --max-old-space-size=8192 fb2_editor.js %*
pause
