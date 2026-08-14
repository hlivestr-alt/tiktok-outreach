@echo off
setlocal EnableExtensions
pushd "%~dp0.." || exit /b 1

echo Starting only discovery-worker...
docker compose --profile production start discovery-worker
if errorlevel 1 goto :fail

set "DISCOVERY_RUNNING="
for /f "usebackq delims=" %%I in (`docker compose ps -q discovery-worker`) do set "DISCOVERY_RUNNING=%%I"
if not defined DISCOVERY_RUNNING (
  echo ERROR: discovery-worker did not reach the running state.
  goto :fail
)

echo Waiting up to 60 seconds for the discovery heartbeat...
powershell -NoProfile -Command "$deadline=(Get-Date).AddSeconds(60); do { try { $status=Invoke-RestMethod -Uri 'http://127.0.0.1:4000/api/v1/system/status' -TimeoutSec 5; if ($status.workers.discovery -eq 'RUNNING') { exit 0 } } catch {}; Start-Sleep -Seconds 2 } while ((Get-Date) -lt $deadline); exit 1"
if errorlevel 1 (
  echo ERROR: discovery-worker container is running, but its heartbeat was not confirmed within 60 seconds.
  goto :fail
)

echo discovery-worker is RUNNING and its heartbeat is healthy.
echo No unrelated service was restarted.
popd
exit /b 0

:fail
popd
exit /b 1

