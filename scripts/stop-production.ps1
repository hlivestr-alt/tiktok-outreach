$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
docker compose --project-directory $projectRoot --profile production --profile outbound-live down
