@echo off
cd /d "%~dp0"
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4545/api/log -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  start "Job Seeker dashboard" /min node src\server.js
  timeout /t 2 /nobreak >nul
)
start "" http://127.0.0.1:4545
