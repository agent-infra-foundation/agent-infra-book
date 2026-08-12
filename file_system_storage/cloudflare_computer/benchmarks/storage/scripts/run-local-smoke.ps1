[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$benchmarkRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$pipelineRoot = Join-Path $benchmarkRoot "local-pipeline"
$resultRoot = Join-Path $benchmarkRoot "results\raw"
$computerdEntry = Join-Path $benchmarkRoot "node_modules\@cloudflare\computerd\dist\cli\computerd.cjs"
$wranglerEntry = Join-Path $benchmarkRoot "node_modules\wrangler\bin\wrangler.js"
$wranglerRuntimeSource = "benchmark-node_modules"
$wranglerConfig = Join-Path $pipelineRoot "wrangler.jsonc"
$workerSource = Join-Path $pipelineRoot "storage-worker.ts"
$runScript = Join-Path $pipelineRoot "run-computerd.sh"
$stopScript = Join-Path $pipelineRoot "stop-computerd.sh"
$smokeScript = Join-Path $pipelineRoot "smoke-once.sh"
$mediumWorkload = Join-Path $pipelineRoot "medium-workload.sh"

$cursor = Get-Item -LiteralPath $benchmarkRoot
while ($null -ne $cursor) {
  $computerRuntimeRoot = Join-Path $cursor.FullName "computer\node_modules"
  $computerWrangler = Join-Path $computerRuntimeRoot "wrangler\bin\wrangler.js"
  $computerWorkerd = Join-Path $computerRuntimeRoot "@cloudflare\workerd-windows-64\bin\workerd.exe"
  if (
    (Test-Path -LiteralPath $computerWrangler) -and
    (Test-Path -LiteralPath $computerWorkerd)
  ) {
    $wranglerEntry = $computerWrangler
    $wranglerRuntimeSource = "sibling-cloudflare-computer-node_modules"
    break
  }
  $cursor = $cursor.Parent
}

foreach ($required in @($computerdEntry, $wranglerEntry, $wranglerConfig, $workerSource, $runScript, $stopScript, $smokeScript, $mediumWorkload)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Missing $required. Run npm.cmd run bootstrap first."
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
  try {
    return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  }
  finally {
    $listener.Stop()
  }
}

function Wait-Http {
  param([string]$Url, [int]$Seconds = 30)
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($Seconds)
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) { return }
    }
    catch {
      Start-Sleep -Milliseconds 200
    }
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Timed out waiting for $Url"
}

function Invoke-WslProbe {
  param([string]$Url)
  $savedPreference = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  try {
    & wsl.exe curl -fsS --max-time 2 $Url 2>$null | Out-Null
    return $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $savedPreference
  }
}

function Wait-WslHttp {
  param([string]$Url, [int]$Seconds = 30)
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($Seconds)
  do {
    if ((Invoke-WslProbe $Url) -eq 0) { return }
    Start-Sleep -Milliseconds 200
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Timed out waiting for WSL to reach $Url"
}

function Wait-WslProcessHttp {
  param([string]$Url, [System.Diagnostics.Process]$Process, [int]$Seconds = 30)
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($Seconds)
  do {
    if ((Invoke-WslProbe $Url) -eq 0) { return }
    $Process.Refresh()
    if ($Process.HasExited) {
      throw "Process $($Process.Id) exited before $Url became ready"
    }
    Start-Sleep -Milliseconds 200
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Timed out waiting for WSL to reach $Url"
}

New-Item -ItemType Directory -Path $resultRoot -Force | Out-Null

$runId = [guid]::NewGuid().ToString("N").Substring(0, 12)
$objectName = "smoke-$runId"
$workerPort = Get-FreePort
$computerdPort = Get-Random -Minimum 46000 -Maximum 52000
$wslRoot = "/tmp/cloudflare-computer-benchmark-$runId"
$mountPoint = "$wslRoot/workspace"
$nativeRoot = "$wslRoot/native"
$pidFile = "$wslRoot/computerd.pid"
$workerOut = Join-Path $resultRoot "local-smoke-$runId-worker.out"
$workerErr = Join-Path $resultRoot "local-smoke-$runId-worker.err"
$computerdOut = Join-Path $resultRoot "local-smoke-$runId-computerd.out"
$computerdErr = Join-Path $resultRoot "local-smoke-$runId-computerd.err"
$resultPath = Join-Path $resultRoot "local-smoke-$runId.json"
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$persistPath = Join-Path $tempBase "cloudflare-computer-pipeline-$runId"

$node = (Get-Command node.exe).Source
$wsl = Join-Path $env:SystemRoot "System32\wsl.exe"
$computerdWsl = Convert-ToWslPath $computerdEntry
$runScriptWsl = Convert-ToWslPath $runScript
$stopScriptWsl = Convert-ToWslPath $stopScript
$smokeScriptWsl = Convert-ToWslPath $smokeScript
$mediumWorkloadWsl = Convert-ToWslPath $mediumWorkload

$workerProcess = $null
$computerdProcess = $null
$workerStarted = $false
$computerdStarted = $false
$workerBase = "http://127.0.0.1:$workerPort"

try {
  $computerdProcess = Start-Process `
    -FilePath $wsl `
    -ArgumentList @(
      "bash", $runScriptWsl,
      $mountPoint,
      "$computerdPort",
      $computerdWsl,
      $pidFile
    ) `
    -RedirectStandardOutput $computerdOut `
    -RedirectStandardError $computerdErr `
    -WindowStyle Hidden `
    -PassThru
  $computerdStarted = $true

  Wait-WslProcessHttp "http://127.0.0.1:$computerdPort/health" $computerdProcess 45
  Wait-Http "http://127.0.0.1:$computerdPort/health" 15

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
      "--var", "BENCHMARK_WORKLOAD:$mediumWorkloadWsl"
    ) `
    -RedirectStandardOutput $workerOut `
    -RedirectStandardError $workerErr `
    -WindowStyle Hidden `
    -PassThru
  $workerStarted = $true
  Wait-Http "$workerBase/health" 45

  if ((Invoke-WslProbe "$workerBase/health") -eq 0) {
    $wslWorkerHost = "127.0.0.1"
  }
  else {
    $wslWorkerHost = (& wsl.exe bash -lc "awk '/nameserver/{print `$2; exit}' /etc/resolv.conf").Trim()
    if ([string]::IsNullOrWhiteSpace($wslWorkerHost)) {
      throw "Could not resolve the Windows host from WSL"
    }
  }
  $wslWorkerBase = "http://${wslWorkerHost}:$workerPort"
  Wait-WslHttp "$wslWorkerBase/health" 15

  Invoke-WebRequest `
    -UseBasicParsing `
    -Method Get `
    -Uri "$workerBase/c/$objectName/ping" `
    -TimeoutSec 5 | Out-Null

  $infoText = (& wsl.exe curl -fsS --max-time 3 "http://127.0.0.1:$computerdPort/__computerd/info") -join ""
  $info = $infoText | ConvertFrom-Json
  if ($info.backend.kind -ne "fuse") {
    throw "Expected real FUSE; computerd reported $($info.backend.kind)"
  }
  if ($info.mountPoint -ne $mountPoint) {
    throw "Expected mount $mountPoint; computerd reported $($info.mountPoint)"
  }

  $runtimePath = "$mountPoint/runtime-smoke.bin"
  $escapedRuntimePath = [System.Uri]::EscapeDataString($runtimePath)
  $runtimeMetrics = Invoke-RestMethod `
    -Method Post `
    -Uri "$workerBase/c/$objectName/runtime-smoke?path=$escapedRuntimePath" `
    -TimeoutSec 60

  $smokeJson = (& wsl.exe bash $smokeScriptWsl $wslWorkerBase $objectName $mountPoint $nativeRoot) -join ""
  if ($LASTEXITCODE -ne 0) { throw "Local pipeline smoke operation failed" }
  $metrics = $smokeJson | ConvertFrom-Json

  $provenance = Get-Content -LiteralPath (Join-Path $benchmarkRoot "vendor\PROVENANCE.json") -Raw | ConvertFrom-Json
  $report = [ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    profile = "local-smoke-once"
    computerCommit = $provenance.sourceCommit
    wranglerRuntimeSource = $wranglerRuntimeSource
    wranglerVersion = [string]((Get-Content -LiteralPath (Join-Path (Split-Path (Split-Path $wranglerEntry -Parent) -Parent) "package.json") -Raw | ConvertFrom-Json).version)
    pipelines = [ordered]@{
      runtimeExec = "Durable Object Workspace -> push -> computerd shell -> FUSE -> pull -> Durable Object SQLite"
      directStorage = "local process -> FUSE -> computerd -> Workspace.pull/SyncRPC -> Durable Object SQLite"
    }
    mount = $info
    objectName = $objectName
    metrics = [ordered]@{
      runtimeExecBracket = $runtimeMetrics
      directFuseStoragePath = $metrics
    }
  }
  [System.IO.File]::WriteAllText(
    $resultPath,
    (($report | ConvertTo-Json -Depth 12) + [Environment]::NewLine),
    [System.Text.UTF8Encoding]::new($false)
  )

  Write-Host "Local Computer pipeline smoke test passed"
  Write-Host "FUSE backend: $($info.backend.kind)"
  Write-Host "Result: $resultPath"
  $report | ConvertTo-Json -Depth 12 | Write-Host
}
finally {
  if ($workerStarted) {
    try {
      Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$workerBase/c/$objectName/reset" -TimeoutSec 3 | Out-Null
    }
    catch {}
  }

  if ($computerdStarted) {
    & wsl.exe bash $stopScriptWsl $pidFile $mountPoint $wslRoot 2>$null | Out-Null
    if ($null -ne $computerdProcess -and -not $computerdProcess.HasExited) {
      try { $computerdProcess.WaitForExit(5000) | Out-Null } catch {}
    }
  }

  if ($workerStarted) {
    if ($null -ne $workerProcess -and -not $workerProcess.HasExited) {
      & taskkill.exe /PID $workerProcess.Id /T /F 2>$null | Out-Null
    }
  }

  $resolvedPersist = [System.IO.Path]::GetFullPath($persistPath)
  if (
    $resolvedPersist.StartsWith(
      $tempBase,
      [System.StringComparison]::OrdinalIgnoreCase
    ) -and
    [System.IO.Path]::GetFileName($resolvedPersist).StartsWith("cloudflare-computer-pipeline-") -and
    (Test-Path -LiteralPath $resolvedPersist)
  ) {
    Remove-Item -LiteralPath $resolvedPersist -Recurse -Force -ErrorAction SilentlyContinue
  }
}
