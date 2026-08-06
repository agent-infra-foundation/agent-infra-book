[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$benchmarkRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$pipelineRoot = Join-Path $benchmarkRoot "local-pipeline"
$resultRoot = Join-Path $benchmarkRoot "results\raw"
$computerdEntry = Join-Path $benchmarkRoot "node_modules\@cloudflare\computerd\dist\cli\computerd.cjs"
$wranglerEntry = Join-Path $benchmarkRoot "node_modules\wrangler\bin\wrangler.js"
$wranglerRuntimeSource = "benchmark-node_modules"
$wranglerVersion = (Get-Content -LiteralPath (Join-Path $benchmarkRoot "node_modules\wrangler\package.json") -Raw | ConvertFrom-Json).version
$workerdVersion = (Get-Content -LiteralPath (Join-Path $benchmarkRoot "node_modules\workerd\package.json") -Raw | ConvertFrom-Json).version
$nodeVersion = (& node --version).Trim()
$wranglerConfig = Join-Path $pipelineRoot "wrangler.jsonc"
$workerSource = Join-Path $pipelineRoot "storage-worker.ts"
$runScript = Join-Path $pipelineRoot "run-computerd.sh"
$stopScript = Join-Path $pipelineRoot "stop-computerd.sh"
$workloadScript = Join-Path $pipelineRoot "medium-workload.sh"
$generatorScript = Join-Path $pipelineRoot "generate-medium-corpus.mjs"
$copyScript = Join-Path $pipelineRoot "copy-medium-batch.mjs"
$summarizeScript = Join-Path $PSScriptRoot "summarize-medium.mjs"

foreach ($required in @(
  $computerdEntry,
  $wranglerEntry,
  $wranglerConfig,
  $workerSource,
  $runScript,
  $stopScript,
  $workloadScript,
  $generatorScript,
  $copyScript,
  $summarizeScript
)) {
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
  try { return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port }
  finally { $listener.Stop() }
}

function Wait-Http {
  param([string]$Url, [int]$Seconds = 30)
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($Seconds)
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) { return }
    }
    catch { Start-Sleep -Milliseconds 200 }
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
  finally { $ErrorActionPreference = $savedPreference }
}

function Wait-WslProcessHttp {
  param([string]$Url, [System.Diagnostics.Process]$Process, [int]$Seconds = 30)
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds($Seconds)
  do {
    if ((Invoke-WslProbe $Url) -eq 0) { return }
    $Process.Refresh()
    if ($Process.HasExited) { throw "Process $($Process.Id) exited before $Url became ready" }
    Start-Sleep -Milliseconds 200
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  throw "Timed out waiting for WSL to reach $Url"
}

function Get-PersistStats {
  param([string]$Path, [string]$WslPath)
  if (-not (Test-Path -LiteralPath $Path)) {
    return [ordered]@{ fileCount = 0; logicalBytes = 0; allocatedBytes = 0 }
  }
  $files = @(Get-ChildItem -LiteralPath $Path -Recurse -File -Force -ErrorAction SilentlyContinue)
  $logical = ($files | Measure-Object -Property Length -Sum).Sum
  if ($null -eq $logical) { $logical = 0 }
  $duText = ((& wsl.exe du -s -B1 -- $WslPath) -join "").Trim()
  $allocated = if ($LASTEXITCODE -eq 0 -and $duText -match '^(\d+)') { [int64]$Matches[1] } else { 0 }
  return [ordered]@{
    fileCount = $files.Count
    logicalBytes = [int64]$logical
    allocatedBytes = $allocated
  }
}

New-Item -ItemType Directory -Path $resultRoot -Force | Out-Null

$runId = [guid]::NewGuid().ToString("N").Substring(0, 12)
$objectName = "medium-$runId"
$workerPort = Get-FreePort
$computerdPort = Get-Random -Minimum 46000 -Maximum 52000
$wslRoot = "/tmp/cloudflare-computer-benchmark-$runId"
$mountPoint = "$wslRoot/workspace"
$nativeRoot = "$wslRoot/native"
$pidFile = "$wslRoot/computerd.pid"
$workerOut = Join-Path $resultRoot "local-medium-$runId-worker.out"
$workerErr = Join-Path $resultRoot "local-medium-$runId-worker.err"
$computerdOut = Join-Path $resultRoot "local-medium-$runId-computerd.out"
$computerdErr = Join-Path $resultRoot "local-medium-$runId-computerd.err"
$resultPath = Join-Path $resultRoot "local-medium-$runId.json"
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$persistPath = Join-Path $tempBase "cloudflare-computer-pipeline-$runId"

$node = (Get-Command node.exe).Source
$wsl = Join-Path $env:SystemRoot "System32\wsl.exe"
$computerdWsl = Convert-ToWslPath $computerdEntry
$runScriptWsl = Convert-ToWslPath $runScript
$stopScriptWsl = Convert-ToWslPath $stopScript
$workloadScriptWsl = Convert-ToWslPath $workloadScript
$persistPathWsl = Convert-ToWslPath $persistPath

$workerProcess = $null
$computerdProcess = $null
$workerStarted = $false
$computerdStarted = $false
$workerBase = "http://127.0.0.1:$workerPort"
$phaseReports = @()

$phases = @(
  [ordered]@{ name = "initialize"; action = "initialize"; step = $null },
  [ordered]@{ name = "list"; action = "list"; step = $null },
  [ordered]@{ name = "read"; action = "read"; step = $null },
  [ordered]@{ name = "duplicate"; action = "duplicate"; step = $null },
  [ordered]@{ name = "edit-one"; action = "edit-one"; step = $null },
  [ordered]@{ name = "edit-separate-1"; action = "edit-separate"; step = 1 },
  [ordered]@{ name = "edit-separate-2"; action = "edit-separate"; step = 2 },
  [ordered]@{ name = "edit-separate-3"; action = "edit-separate"; step = 3 },
  [ordered]@{ name = "edit-separate-4"; action = "edit-separate"; step = 4 },
  [ordered]@{ name = "edit-separate-5"; action = "edit-separate"; step = 5 },
  [ordered]@{ name = "edit-five-bracket"; action = "edit-five-bracket"; step = $null },
  [ordered]@{ name = "append"; action = "append"; step = $null },
  [ordered]@{ name = "prepend"; action = "prepend"; step = $null },
  [ordered]@{ name = "delete-copy"; action = "delete-copy"; step = $null },
  [ordered]@{ name = "delete-all"; action = "delete-all"; step = $null }
)

try {
  $computerdProcess = Start-Process `
    -FilePath $wsl `
    -ArgumentList @("bash", $runScriptWsl, $mountPoint, "$computerdPort", $computerdWsl, $pidFile) `
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
      "--var", "BENCHMARK_WORKLOAD:$workloadScriptWsl"
    ) `
    -RedirectStandardOutput $workerOut `
    -RedirectStandardError $workerErr `
    -WindowStyle Hidden `
    -PassThru
  $workerStarted = $true
  Wait-Http "$workerBase/health" 45

  Invoke-WebRequest -UseBasicParsing -Uri "$workerBase/c/$objectName/ping" -TimeoutSec 5 | Out-Null
  $infoText = (& wsl.exe curl -fsS --max-time 3 "http://127.0.0.1:$computerdPort/__computerd/info") -join ""
  $info = $infoText | ConvertFrom-Json
  if ($info.backend.kind -ne "fuse") { throw "Expected real FUSE; computerd reported $($info.backend.kind)" }
  if ($info.mountPoint -ne $mountPoint) { throw "Expected mount $mountPoint; computerd reported $($info.mountPoint)" }

  foreach ($phase in $phases) {
    Write-Host "Running phase $($phase.name)"
    $nativeArgs = @("env", "BENCHMARK_EMIT_STATS=1", "bash", $workloadScriptWsl, $phase.action, $nativeRoot)
    if ($null -ne $phase.step) { $nativeArgs += [string]$phase.step }
    $nativeText = (& $wsl @nativeArgs) -join ""
    if ($LASTEXITCODE -ne 0) { throw "Native phase $($phase.name) failed" }
    $native = $nativeText | ConvertFrom-Json

    $encodedPhase = [System.Uri]::EscapeDataString($phase.name)
    $computer = Invoke-RestMethod `
      -Method Post `
      -Uri "$workerBase/c/$objectName/runtime-medium?phase=$encodedPhase" `
      -TimeoutSec 900

    if (
      [int64]$native.fileCount -ne [int64]$computer.verification.storage.fileCount -or
      [int64]$native.logicalBytes -ne [int64]$computer.verification.storage.logicalBytes
    ) {
      throw "Native and authoritative Computer state differ after $($phase.name)"
    }

    $phaseReports += [ordered]@{
      phase = $phase.name
      native = $native
      computer = $computer
      workerdPersist = Get-PersistStats $persistPath $persistPathWsl
    }
  }

  $provenance = Get-Content -LiteralPath (Join-Path $benchmarkRoot "vendor\PROVENANCE.json") -Raw | ConvertFrom-Json
  $report = [ordered]@{
    generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    profile = "native-vs-computer-medium-v1"
    computerCommit = $provenance.sourceCommit
    packageSha256 = $provenance.packageSha256
    wranglerRuntimeSource = $wranglerRuntimeSource
    runtimeVersions = [ordered]@{
      node = $nodeVersion
      wrangler = $wranglerVersion
      workerd = $workerdVersion
    }
    environment = [ordered]@{
      platform = "WSL2"
      command = "identical Bash workload"
      nativePath = "native WSL filesystem"
      computerPath = "Workspace.runtime.exec -> Bash -> FUSE -> computerd VFS -> pull -> Durable Object SQLite"
      cachePolicy = "warm local caches; no page-cache eviction"
      executionPolicy = "one deterministic run per scenario"
      syncBatchPolicy = "ordinary create/duplicate classes use at most 40 hashes per bracket; the single 32 MiB boundary-file bracket references 64"
      observedUnbatchedFailure = "too many SQL variables at offset 417: SQLITE_ERROR"
    }
    corpus = [ordered]@{
      profile = "medium-v1"
      fileCount = 6385
      logicalBytes = 288129024
      description = "5000x4KiB + 1000x32KiB + 256x256KiB + 128x1MiB + 1x32MiB"
      content = "deterministic AES-256-CTR pseudorandom bytes; deliberate duplication only in duplicate phase"
    }
    mount = $info
    objectName = $objectName
    phases = $phaseReports
  }
  [System.IO.File]::WriteAllText(
    $resultPath,
    (($report | ConvertTo-Json -Depth 16) + [Environment]::NewLine),
    [System.Text.UTF8Encoding]::new($false)
  )
  & $node $summarizeScript $resultPath (Join-Path $benchmarkRoot "results")
  if ($LASTEXITCODE -ne 0) { throw "Medium result summarization failed" }

  Write-Host "Medium native-vs-Computer benchmark passed"
  Write-Host "FUSE backend: $($info.backend.kind)"
  Write-Host "Result: $resultPath"
}
finally {
  if ($workerStarted) {
    try {
      Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$workerBase/c/$objectName/reset" -TimeoutSec 10 | Out-Null
    }
    catch {}
  }
  if ($computerdStarted) {
    & wsl.exe bash $stopScriptWsl $pidFile $mountPoint $wslRoot 2>$null | Out-Null
    if ($null -ne $computerdProcess -and -not $computerdProcess.HasExited) {
      try { $computerdProcess.WaitForExit(5000) | Out-Null } catch {}
    }
  }
  if ($workerStarted -and $null -ne $workerProcess -and -not $workerProcess.HasExited) {
    & taskkill.exe /PID $workerProcess.Id /T /F 2>$null | Out-Null
  }

  $resolvedPersist = [System.IO.Path]::GetFullPath($persistPath)
  if (
    $resolvedPersist.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -and
    [System.IO.Path]::GetFileName($resolvedPersist).StartsWith("cloudflare-computer-pipeline-") -and
    (Test-Path -LiteralPath $resolvedPersist)
  ) {
    Remove-Item -LiteralPath $resolvedPersist -Recurse -Force -ErrorAction SilentlyContinue
  }
}
