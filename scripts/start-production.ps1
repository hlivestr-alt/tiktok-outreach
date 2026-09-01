[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot ".env"
if (-not (Test-Path -LiteralPath $envFile)) { throw "Missing repository .env. Copy .env.example and configure TikTok Outreach credentials." }

$env:APP_VERSION = (git -C $projectRoot rev-parse HEAD).Trim()
$env:BUILD_TIMESTAMP = [DateTime]::UtcNow.ToString("o")
$env:OUTBOUND_MODE = "live"
$profile = "production"
$services = @("api", "web", "outbound-live")

$validationContainer = docker ps -aq --filter "name=^tiktokoutreach-validation-api$"
if ($validationContainer) { docker rm -f tiktokoutreach-validation-api | Out-Null }
docker compose --project-directory $projectRoot --env-file $envFile --profile $profile build $services
docker compose --project-directory $projectRoot --env-file $envFile --profile $profile up -d --remove-orphans $services
docker compose --project-directory $projectRoot --env-file $envFile --profile $profile ps
