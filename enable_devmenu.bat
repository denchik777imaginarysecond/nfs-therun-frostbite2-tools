@echo off
rem Unlocks the hidden developer menu (Free Roam) in Need for Speed: The Run.
rem Double-click to run. Asks for administrator rights (the game is in Program Files).
rem The game files are not changed: the menu is switched on through the mod package Update\Mods.

net session >nul 2>&1
if errorlevel 1 (
  rem restart this file as administrator; an empty -ArgumentList makes PowerShell fail, so pass it only when needed
  if "%~1"=="" (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  ) else (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  )
  if errorlevel 1 (
    echo Could not get administrator rights. Right-click this file and choose "Run as administrator".
    pause
  )
  exit /b
)

cd /d "%~dp0"
rem use the Node.js that comes with the tool (node\node.exe) when it is there, otherwise the installed one
set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
if "%NODE%"=="node" (
  where node >nul 2>&1
  if errorlevel 1 (
    echo Node.js was not found. Opening https://nodejs.org - install the LTS version, then run this again.
    start "" https://nodejs.org
    pause
    exit /b 1
  )
)
"%NODE%" --max-old-space-size=8192 fb2_devmenu.js enable %*
pause
