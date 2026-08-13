@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-production.ps1" %*
exit /b %ERRORLEVEL%
