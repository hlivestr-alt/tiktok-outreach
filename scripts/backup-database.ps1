[CmdletBinding()]
param([string]$Destination = (Join-Path (Split-Path -Parent $PSScriptRoot) "backups"))
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$resolvedDestination = [System.IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Force -Path $resolvedDestination | Out-Null
$timestamp = [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")
$containerPath = "/tmp/tiktok-outreach-$timestamp.dump"
$outputPath = Join-Path $resolvedDestination "tiktok-outreach-$timestamp.dump"
docker compose --project-directory $projectRoot exec -T postgres pg_dump -U affiliate -d affiliate_outreach --format=custom --no-owner --file=$containerPath
$containerId = (docker compose --project-directory $projectRoot ps -q postgres).Trim()
if (-not $containerId) { throw "TikTok Outreach PostgreSQL container is not running." }
docker cp "${containerId}:$containerPath" $outputPath
docker exec $containerId rm -f $containerPath
Write-Host "Backup created: $outputPath"
