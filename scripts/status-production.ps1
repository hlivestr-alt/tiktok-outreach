$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
docker compose --project-directory $projectRoot --profile production --profile outbound-live ps
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:4000/health" -TimeoutSec 3
  Write-Host "API readiness: $($health.status) | version $($health.version)"
  $system = Invoke-RestMethod -Uri "http://127.0.0.1:4000/api/v1/system/status" -TimeoutSec 3
  Write-Host "Workers: discovery=$($system.workers.discovery) history=$($system.workers.history) outbound=$($system.workers.outbound)"
  Write-Host "Outbound: $($system.outbound.mode) | TikTok: $($system.tiktok.state) | queued=$($system.workload.queuedOutbound) sending=$($system.workload.currentlySending) unknown=$($system.workload.unknownDeliveries)"
} catch { Write-Warning "API status endpoint is unavailable: $($_.Exception.Message)" }
