[CmdletBinding()]
param([switch]$LiveOutbound)
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot ".env"
if (-not (Test-Path -LiteralPath $envFile)) { throw "Missing repository .env. Copy .env.example and configure TikTok Outreach credentials." }

$env:APP_VERSION = (git -C $projectRoot rev-parse HEAD).Trim()
$env:BUILD_TIMESTAMP = [DateTime]::UtcNow.ToString("o")
if ($LiveOutbound) {
  $env:OUTBOUND_MODE = "live"
  $env:ENABLE_LIVE_TIKTOK_OUTBOUND = "I_UNDERSTAND_THIS_SENDS_REAL_MESSAGES"
  $profile = "outbound-live"
} else {
  $env:OUTBOUND_MODE = "read_only"
  $env:ENABLE_LIVE_TIKTOK_OUTBOUND = "NOT_ACKNOWLEDGED"
  $profile = "production"
}

$validationContainer = docker ps -aq --filter "name=^tiktokoutreach-validation-api$"
if ($validationContainer) { docker rm -f tiktokoutreach-validation-api | Out-Null }
docker compose --project-directory $projectRoot --env-file $envFile --profile $profile build
docker compose --project-directory $projectRoot --env-file $envFile --profile $profile up -d --remove-orphans
docker compose --project-directory $projectRoot --env-file $envFile --profile $profile ps
