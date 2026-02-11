@echo off
setlocal
cd /d %~dp0

if not exist app\node_modules (
  echo [myTube] Installing dependencies for first run...
  call npm install --prefix app
  if errorlevel 1 (
    echo [myTube] Failed to install dependencies.
    pause
    exit /b 1
  )
)

start "" http://localhost:3210
call npm run --prefix app start
