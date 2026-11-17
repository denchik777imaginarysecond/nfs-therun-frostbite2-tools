@echo off
rem Undoes enable_devmenu.bat: restores every game file changed by fb2_patch.js.
rem Double-click to run. Asks for administrator rights.

net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
node fb2_devmenu.js disable %*
pause
