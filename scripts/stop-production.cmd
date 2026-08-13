@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-production.ps1" %*
exit /b %ERRORLEVEL%
