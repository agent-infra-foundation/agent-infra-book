[CmdletBinding()]
param(
  [ValidateSet("baseline", "c3")][string]$Variant,
  [ValidateSet("smoke", "volume")][string]$Profile = "smoke",
  [string]$BatchId = "",
  [string]$PairId = "",
  [int]$Trial = 0,
  [int]$BenchmarkSeed = 0,
  [int]$OrderIndex = 0
)

$ErrorActionPreference = "Stop"
$e2eRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$variantRoot = Join-Path $e2eRoot "variants\$Variant"
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
  param([string]$Url, [System.Diagnostics.Process]$Process, [int]$Seconds = 45)
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($Seconds)
  do {
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try {
      & wsl.exe curl -fsS --max-time 2 $Url 2>$null | Out-Null
      $probeExit = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $savedPreference }
    if ($probeExit -eq 0) { return }
    $Process.Refresh()
    if ($Process.HasExited) { throw "computerd exited before $Url became ready" }
    Start-Sleep -Milliseconds 200
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Timed out waiting for WSL to reach $Url"
}

New-Item -ItemType Directory -Path $resultRoot -Force | Out-Null
$runId = [guid]::NewGuid().ToString("N").Substring(0, 12)
$objectName = "$Variant-$Profile-$runId"
$workerPort = Get-FreePort
$computerdPort = Get-FreePort
$wslRoot = "/tmp/cloudflare-computer-c3-$Variant-$runId"
$mountPoint = "$wslRoot/workspace"
$pidFile = "$wslRoot/computerd.pid"
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$persistPath = Join-Path $tempBase "cloudflare-computer-c3-$Variant-$runId"
$workerOut = Join-Path $resultRoot "$Variant-$Profile-$runId-worker.out"
$workerErr = Join-Path $resultRoot "$Variant-$Profile-$runId-worker.err"
$computerdOut = Join-Path $resultRoot "$Variant-$Profile-$runId-computerd.out"
$computerdErr = Join-Path $resultRoot "$Variant-$Profile-$runId-computerd.err"
$resultPath = Join-Path $resultRoot "$Variant-$Profile-$runId.json"

$node = (Get-Command node.exe).Source
$wsl = Join-Path $env:SystemRoot "System32\wsl.exe"
$computerdWsl = Convert-ToWslPath $computerdEntry
$runScriptWsl = Convert-ToWslPath $runScript
$stopScriptWsl = Convert-ToWslPath $stopScript
$workerProcess = $null
$computerdProcess = $null
$workerBase = "http://127.0.0.1:$workerPort"

try {
  $computerdProcess = Start-Process `
    -FilePath $wsl `
    -ArgumentList @("bash", $runScriptWsl, $mountPoint, "$computerdPort", $computerdWsl, $pidFile) `
    -RedirectStandardOutput $computerdOut `
    -RedirectStandardError $computerdErr `
    -WindowStyle Hidden `
    -PassThru
  Wait-WslHttp "http://127.0.0.1:$computerdPort/health" $computerdProcess 60
  Wait-Http "http://127.0.0.1:$computerdPort/health" 20

  $workerProcess = Start-Process `
    -FilePath $node `
    -ArgumentList @(
      $wranglerEntry,
      "dev",
      "--config", $wranglerConfig,
      "--port", "$workerPort",
      "--ip", "127.0.0.1",
      "--persist-to", $persistPath,
      "--var", "COMPUTERD_URL:ws://127.0.0.1:$computerdPort/ws",
      "--var", "BENCHMARK_MOUNT:$mountPoint",
      "--var", "BENCHMARK_VARIANT:$Variant"
    ) `
    -RedirectStandardOutput $workerOut `
    -RedirectStandardError $workerErr `
    -WindowStyle Hidden `
    -PassThru
  Wait-Http "$workerBase/health" 60

  Invoke-WebRequest -UseBasicParsing -Uri "$workerBase/c/$objectName/ping" -TimeoutSec 10 | Out-Null
  $infoText = (& wsl.exe curl -fsS --max-time 5 "http://127.0.0.1:$computerdPort/__computerd/info") -join ""
  $info = $infoText | ConvertFrom-Json
  if ($info.backend.kind -ne "fuse") { throw "Expected FUSE; computerd reported $($info.backend.kind)" }
  if ($info.mountPoint -ne $mountPoint) { throw "Unexpected mount point $($info.mountPoint)" }

  $measurement = Invoke-RestMethod `
    -Method Post `
    -Uri "$workerBase/c/$objectName/run?profile=$Profile" `
    -TimeoutSec 900
  $report = [ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    sourceCommit = "76d9e75c5688713b656bce85540d9e0071cece8b"
    variant = $Variant
    profile = $Profile
    batchId = $BatchId
    pairId = $PairId
    trial = $Trial
    benchmarkSeed = $BenchmarkSeed
    orderIndex = $OrderIndex
    objectName = $objectName
    mount = $info
    measurement = $measurement
  }
  [System.IO.File]::WriteAllText(
    $resultPath,
    (($report | ConvertTo-Json -Depth 20) + [Environment]::NewLine)
  )
  Write-Host "Full Computer pipeline $Variant/$Profile passed"
  Write-Host "Result: $resultPath"
}
finally {
  if ($null -ne $workerProcess -and -not $workerProcess.HasExited) {
    try { Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$workerBase/c/$objectName/reset" -TimeoutSec 3 | Out-Null } catch {}
  }
  if ($null -ne $computerdProcess) {
    & wsl.exe bash $stopScriptWsl $pidFile $mountPoint $wslRoot 2>$null | Out-Null
    if (-not $computerdProcess.HasExited) { try { $computerdProcess.WaitForExit(5000) | Out-Null } catch {} }
  }
  if ($null -ne $workerProcess -and -not $workerProcess.HasExited) {
    & taskkill.exe /PID $workerProcess.Id /T /F 2>$null | Out-Null
  }
  $resolvedPersist = [System.IO.Path]::GetFullPath($persistPath)
  if (
    $resolvedPersist.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -and
    [System.IO.Path]::GetFileName($resolvedPersist).StartsWith("cloudflare-computer-c3-") -and
    (Test-Path -LiteralPath $resolvedPersist)
  ) {
    Remove-Item -LiteralPath $resolvedPersist -Recurse -Force -ErrorAction SilentlyContinue
  }
}
