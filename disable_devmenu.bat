@echo off
rem Undoes enable_devmenu.bat: restores every game file changed by fb2_patch.js.
rem Double-click to run. Asks for administrator rights.

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
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed. Opening https://nodejs.org - install the LTS version, then run this again.
  start "" https://nodejs.org
  pause
  exit /b 1
)
node fb2_devmenu.js disable %*
pause
