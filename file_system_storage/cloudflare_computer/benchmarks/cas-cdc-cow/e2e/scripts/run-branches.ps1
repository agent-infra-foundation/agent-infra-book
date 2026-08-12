[CmdletBinding()]
param(
  [ValidateSet("baseline", "c3")][string]$Variant = "c3",
  [string]$BatchId = "",
  [string]$PairId = "",
  [int]$Trial = 0,
  [int]$BenchmarkSeed = 0,
  [int]$OrderIndex = 0,
  [switch]$SkipReport
)

$ErrorActionPreference = "Stop"
$variant = $Variant
$e2eRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$variantRoot = Join-Path $e2eRoot "variants\$variant"
$resultRoot = Join-Path $e2eRoot "results\raw"
$computerdEntry = Join-Path $variantRoot "node_modules\@cloudflare\computerd\dist\cli\computerd.cjs"
$wranglerEntry = Join-Path $variantRoot "node_modules\wrangler\bin\wrangler.js"
$wranglerConfig = Join-Path $variantRoot "wrangler.jsonc"
$runScript = Join-Path $e2eRoot "template\run-computerd.sh"
$stopScript = Join-Path $e2eRoot "template\stop-computerd.sh"
foreach ($required in @($computerdEntry, $wranglerEntry, $wranglerConfig, $runScript, $stopScript)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Missing $required. Run scripts/prepare-variants.ps1 first."
  }
}

function Convert-ToWslPath {
  param([string]$WindowsPath)
  $normalized = $WindowsPath.Replace("\", "/")
  $converted = ((& wsl.exe wslpath -a $normalized) -join "").Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($converted)) {
    throw "Could not convert path for WSL: $WindowsPath"
  }
  return $converted
}

function Get-FreePort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port }
  finally { $listener.Stop() }
}

function Wait-Http {
  param([string]$Url, [int]$Seconds = 45)
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($Seconds)
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) { return }
    } catch { Start-Sleep -Milliseconds 200 }
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Timed out waiting for $Url"
}

function Wait-WslHttp {
  param([string]$Url, [System.Diagnostics.Process]$Process, [int]$Seconds = 60)
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($Seconds)
  do {
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try {
      & wsl.exe curl -fsS --max-time 2 $Url 2>$null | Out-Null
      $probeExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
    if ($probeExit -eq 0) { return }
    $Process.Refresh()
    if ($Process.HasExited) { throw "computerd exited before $Url became ready" }
    Start-Sleep -Milliseconds 200
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Timed out waiting for WSL to reach $Url"
}

New-Item -ItemType Directory -Path $resultRoot -Force | Out-Null
$runId = [guid]::NewGuid().ToString("N").Substring(0, 12)
$objectName = "$variant-branches-$runId"
$workerPort = Get-FreePort
$computerdPortA = Get-FreePort
$computerdPortB = Get-FreePort
$wslRootA = "/tmp/cloudflare-computer-branch-$variant-$runId-a"
$wslRootB = "/tmp/cloudflare-computer-branch-$variant-$runId-b"
$mountA = "$wslRootA/workspace"
$mountB = "$wslRootB/workspace"
$pidFileA = "$wslRootA/computerd.pid"
$pidFileB = "$wslRootB/computerd.pid"
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$persistPath = Join-Path $tempBase "cloudflare-computer-branch-$variant-$runId"
$workerOut = Join-Path $resultRoot "$variant-branches-$runId-worker.out"
$workerErr = Join-Path $resultRoot "$variant-branches-$runId-worker.err"
$computerdOutA = Join-Path $resultRoot "$variant-branches-$runId-computerd-a.out"
$computerdErrA = Join-Path $resultRoot "$variant-branches-$runId-computerd-a.err"
$computerdOutB = Join-Path $resultRoot "$variant-branches-$runId-computerd-b.out"
$computerdErrB = Join-Path $resultRoot "$variant-branches-$runId-computerd-b.err"
$resultPath = Join-Path $resultRoot "$variant-branches-$runId.json"

$node = (Get-Command node.exe).Source
$wsl = Join-Path $env:SystemRoot "System32\wsl.exe"
$computerdWsl = Convert-ToWslPath $computerdEntry
$runScriptWsl = Convert-ToWslPath $runScript
$stopScriptWsl = Convert-ToWslPath $stopScript
$workerProcess = $null
$computerdProcessA = $null
$computerdProcessB = $null
$workerBase = "http://127.0.0.1:$workerPort"

try {
  $computerdProcessA = Start-Process `
    -FilePath $wsl `
    -ArgumentList @("bash", $runScriptWsl, $mountA, "$computerdPortA", $computerdWsl, $pidFileA) `
    -RedirectStandardOutput $computerdOutA `
    -RedirectStandardError $computerdErrA `
    -WindowStyle Hidden `
    -PassThru
  $computerdProcessB = Start-Process `
    -FilePath $wsl `
    -ArgumentList @("bash", $runScriptWsl, $mountB, "$computerdPortB", $computerdWsl, $pidFileB) `
    -RedirectStandardOutput $computerdOutB `
    -RedirectStandardError $computerdErrB `
    -WindowStyle Hidden `
    -PassThru
  Wait-WslHttp "http://127.0.0.1:$computerdPortA/health" $computerdProcessA
  Wait-WslHttp "http://127.0.0.1:$computerdPortB/health" $computerdProcessB
  Wait-Http "http://127.0.0.1:$computerdPortA/health" 20
  Wait-Http "http://127.0.0.1:$computerdPortB/health" 20

  $workerProcess = Start-Process `
    -FilePath $node `
    -ArgumentList @(
      $wranglerEntry,
      "dev",
      "--config", $wranglerConfig,
      "--port", "$workerPort",
      "--ip", "127.0.0.1",
      "--persist-to", $persistPath,
      "--var", "COMPUTERD_URL:ws://127.0.0.1:$computerdPortA/ws",
      "--var", "BENCHMARK_MOUNT:$mountA",
      "--var", "BENCHMARK_VARIANT:$variant",
      "--var", "COMPUTERD_URL_A:ws://127.0.0.1:$computerdPortA/ws",
      "--var", "COMPUTERD_URL_B:ws://127.0.0.1:$computerdPortB/ws",
      "--var", "BENCHMARK_MOUNT_A:$mountA",
      "--var", "BENCHMARK_MOUNT_B:$mountB"
    ) `
    -RedirectStandardOutput $workerOut `
    -RedirectStandardError $workerErr `
    -WindowStyle Hidden `
    -PassThru
  Wait-Http "$workerBase/health" 60
  Invoke-WebRequest -UseBasicParsing -Uri "$workerBase/c/$objectName/ping" -TimeoutSec 10 | Out-Null

  $infoA = ((& wsl.exe curl -fsS --max-time 5 "http://127.0.0.1:$computerdPortA/__computerd/info") -join "") | ConvertFrom-Json
  $infoB = ((& wsl.exe curl -fsS --max-time 5 "http://127.0.0.1:$computerdPortB/__computerd/info") -join "") | ConvertFrom-Json
  if ($infoA.backend.kind -ne "fuse" -or $infoB.backend.kind -ne "fuse") {
    throw "Both branch executors must report FUSE"
  }
  if ($infoA.mountPoint -ne $mountA -or $infoB.mountPoint -ne $mountB) {
    throw "Unexpected branch mount points"
  }

  $measurement = Invoke-RestMethod `
    -Method Post `
    -Uri "$workerBase/c/$objectName/branches" `
    -TimeoutSec 900
  $report = [ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    sourceCommit = "76d9e75c5688713b656bce85540d9e0071cece8b"
    variant = $variant
    profile = "branches"
    batchId = $BatchId
    pairId = $PairId
    trial = $Trial
    benchmarkSeed = $BenchmarkSeed
    orderIndex = $OrderIndex
    objectName = $objectName
    mounts = @($infoA, $infoB)
    measurement = $measurement
  }
  [System.IO.File]::WriteAllText(
    $resultPath,
    (($report | ConvertTo-Json -Depth 30) + [Environment]::NewLine)
  )
  if (-not $SkipReport) {
    & node (Join-Path $PSScriptRoot "report-branches.mjs")
    if ($LASTEXITCODE -ne 0) { throw "branch report generation failed" }
  }
  Write-Host "Branch-aware Computer pipeline $variant passed"
  Write-Host "Result: $resultPath"
}
finally {
  if ($null -ne $workerProcess -and -not $workerProcess.HasExited) {
    try { Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$workerBase/c/$objectName/reset" -TimeoutSec 3 | Out-Null } catch {}
  }
  if ($null -ne $computerdProcessA) {
    & wsl.exe bash $stopScriptWsl $pidFileA $mountA $wslRootA 2>$null | Out-Null
    if (-not $computerdProcessA.HasExited) { try { $computerdProcessA.WaitForExit(5000) | Out-Null } catch {} }
  }
  if ($null -ne $computerdProcessB) {
    & wsl.exe bash $stopScriptWsl $pidFileB $mountB $wslRootB 2>$null | Out-Null
    if (-not $computerdProcessB.HasExited) { try { $computerdProcessB.WaitForExit(5000) | Out-Null } catch {} }
  }
  if ($null -ne $workerProcess -and -not $workerProcess.HasExited) {
    & taskkill.exe /PID $workerProcess.Id /T /F 2>$null | Out-Null
  }
  $resolvedPersist = [System.IO.Path]::GetFullPath($persistPath)
  if (
    $resolvedPersist.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -and
    [System.IO.Path]::GetFileName($resolvedPersist).StartsWith("cloudflare-computer-branch-") -and
    (Test-Path -LiteralPath $resolvedPersist)
  ) {
    Remove-Item -LiteralPath $resolvedPersist -Recurse -Force -ErrorAction SilentlyContinue
  }
}
