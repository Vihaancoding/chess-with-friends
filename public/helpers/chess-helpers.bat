@echo off
REM Chess helpers for Windows: keeps headless browsers on the site so they do the game analysis (Live, Reels, move stats).
REM Double-click to run. First time: installs Playwright and asks for the helper accounts (kept only on this computer,
REM in %USERPROFILE%\chess-helpers\accounts.txt). Close the window or press Ctrl+C to stop.
setlocal
title Chess helpers
set "SITE=https://chess-30-com.vercel.app"
set "DIR=%USERPROFILE%\chess-helpers"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Opening nodejs.org: install the LTS version, then double-click this file again.
  start https://nodejs.org
  pause
  exit /b 1
)
if not exist "%DIR%" mkdir "%DIR%"
cd /d "%DIR%"

echo Getting the latest helper from %SITE% ...
powershell -NoProfile -Command "Invoke-WebRequest -UseBasicParsing '%SITE%/helpers/run-helpers.js' -OutFile 'run-helpers.js'"
if errorlevel 1 goto fail

if not exist "node_modules\playwright" (
  echo Installing Playwright, first time only ...
  call npm i playwright --no-audit --no-fund
  if errorlevel 1 goto fail
)
echo Making sure the browser is installed ...
call npx playwright install chromium
if errorlevel 1 goto fail

if not exist accounts.txt (
  echo.
  echo Enter 2 or more DIFFERENT helper accounts, as  email:password,email:password  (spaces are ignored)
  echo Use accounts that will not be playing while this runs. They are saved only on this computer.
  powershell -NoProfile -Command "$a = Read-Host 'Accounts'; [IO.File]::WriteAllText((Join-Path (Get-Location) 'accounts.txt'), ($a -replace '\s',''))"
)
set /p HELPER_ACCOUNTS=<accounts.txt
set "HELPER_URL=%SITE%"
echo.
echo Starting. Keep this window open (and the laptop awake). To change the accounts, delete accounts.txt in %DIR%.
node run-helpers.js
echo.
echo The helpers stopped. If logins failed, delete %DIR%\accounts.txt and run this again.
pause
exit /b 0

:fail
echo.
echo Something went wrong (see above). Check the internet connection and run this file again.
pause
exit /b 1
