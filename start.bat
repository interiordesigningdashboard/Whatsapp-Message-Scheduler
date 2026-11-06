@echo off
REM Starts the WhatsApp Scheduler. Used by Windows Task Scheduler at log-on.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
if not exist data mkdir data
node src\index.js >> data\app.log 2>&1
