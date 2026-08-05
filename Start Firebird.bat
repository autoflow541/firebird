@echo off
setlocal
cd /d "%~dp0"

if not exist package.json (
  echo.
  echo Firebird could not find package.json in:
  echo %CD%
  echo.
  pause
  exit /b 1
)

set "npm_config_cache=%CD%\work\npm-cache"
set "electron_config_cache=%CD%\work\electron-cache"

if not exist node_modules\electron (
  echo Installing the Firebird desktop runtime...
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo Installation failed. Check the message above.
    pause
    exit /b 1
  )
)

echo Starting Firebird Show Control...
call npm.cmd start

if errorlevel 1 (
  echo.
  echo Firebird stopped with an error. Check the message above.
  pause
)
