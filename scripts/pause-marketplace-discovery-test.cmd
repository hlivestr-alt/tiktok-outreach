@echo off
setlocal EnableExtensions
pushd "%~dp0.." || exit /b 1

echo Current Compose state:
docker compose ps -a
if errorlevel 1 goto :fail

echo Stopping only discovery-worker...
docker compose stop -t 30 discovery-worker
if errorlevel 1 goto :fail

for /f "usebackq delims=" %%I in (`docker compose ps -q discovery-worker`) do set "DISCOVERY_RUNNING=%%I"
if defined DISCOVERY_RUNNING (
  echo ERROR: discovery-worker is still running.
  goto :fail
)

for /f "usebackq delims=" %%I in (`docker compose ps -q outbound-live`) do set "OUTBOUND_RUNNING=%%I"
if defined OUTBOUND_RUNNING (
  echo outbound-live is running; stopping it as required...
  docker compose stop -t 30 outbound-live
  if errorlevel 1 goto :fail
)

for /f "usebackq delims=" %%I in (`docker compose ps -q outbound-live`) do set "OUTBOUND_STILL_RUNNING=%%I"
if defined OUTBOUND_STILL_RUNNING (
  echo ERROR: outbound-live is still running.
  goto :fail
)

for %%S in (postgres redis api web history-worker) do call :require_running %%S || goto :fail

echo.
echo SAFE FOR TESTING: discovery-worker=STOPPED and outbound-live=STOPPED.
echo With both relevant containers stopped, neither has a process capable of an in-flight Marketplace Search request.
echo postgres, redis, api, web, and history-worker remain running.
echo No database rows, campaign state, timestamps, queues, or jobs were changed.
popd
exit /b 0

:require_running
set "RUNNING_ID="
for /f "usebackq delims=" %%I in (`docker compose ps -q %1`) do set "RUNNING_ID=%%I"
if not defined RUNNING_ID (
  echo ERROR: required service %1 is not running.
  exit /b 1
)
echo Verified running: %1
exit /b 0

:fail
echo Pause verification failed. Normal services were not restarted or altered.
popd
exit /b 1
