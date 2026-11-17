@echo off
rem Unlocks the hidden developer menu (Free Roam) in Need for Speed: The Run.
rem Double-click to run. Needs Node.js 18+. Asks for administrator rights (the game is in Program Files).
rem Custom game folder: enable_devmenu.bat --game "D:\Games\Need For Speed The Run"

net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node fb2_devmenu.js enable %*
pause
