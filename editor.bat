@echo off
rem Starts the asset editor and opens it in your web browser. Keep this window open while you use it.
rem No administrator rights needed: the editor only reads the game files.

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
"%NODE%" --max-old-space-size=8192 fb2_editor.js %*
pause
