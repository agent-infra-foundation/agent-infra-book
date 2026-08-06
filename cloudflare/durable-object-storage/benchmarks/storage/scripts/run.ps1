[CmdletBinding()]
param(
  [ValidateSet("smoke", "full")]
  [string]$Profile = "smoke"
)

$ErrorActionPreference = "Stop"
$benchmarkRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$provenancePath = Join-Path $benchmarkRoot "vendor/PROVENANCE.json"

if (-not (Test-Path -LiteralPath $provenancePath)) {
  throw "Missing vendor provenance. Run npm run bootstrap first."
}
if (-not (Test-Path -LiteralPath (Join-Path $benchmarkRoot "node_modules"))) {
  throw "Missing dependencies. Run npm run bootstrap first."
}

$provenance = Get-Content -LiteralPath $provenancePath -Raw | ConvertFrom-Json
$scriptName = "bench:$Profile"

Push-Location $benchmarkRoot
$previousErrorActionPreference = $ErrorActionPreference
try {
  # Merge stderr inside cmd.exe. If PowerShell performs the merge itself, a
  # harmless workerd warning becomes a noisy NativeCommandError record.
  $nativeCommand = "npm.cmd run $scriptName 2>&1"
  $output = & cmd.exe /d /s /c $nativeCommand | Tee-Object -Variable captured
  $exitCode = $LASTEXITCODE
  $output |
    ForEach-Object {
      if ([string]$_ -like "BENCHMARK_JSON:*") { "[benchmark report captured]" } else { $_ }
    } |
    Out-Host
}
finally {
  $ErrorActionPreference = $previousErrorActionPreference
  Pop-Location
}

if ($exitCode -ne 0) {
  throw "Benchmark command failed with exit code $exitCode"
}

$allOutput = $captured -join [Environment]::NewLine
$match = [regex]::Match($allOutput, "BENCHMARK_JSON:(\{.*\})", "Singleline")
if (-not $match.Success) {
  throw "Benchmark output did not contain BENCHMARK_JSON"
}

$report = $match.Groups[1].Value | ConvertFrom-Json
$envelope = [ordered]@{
  provenance = $provenance
  report = $report
}

$rawRoot = Join-Path $benchmarkRoot "results/raw"
New-Item -ItemType Directory -Path $rawRoot -Force | Out-Null
$stamp = [DateTimeOffset]::UtcNow.ToString("yyyyMMdd-HHmmss")
$resultPath = Join-Path $rawRoot ("{0}-{1}.json" -f $stamp, $Profile)
$logPath = Join-Path $rawRoot ("{0}-{1}.log" -f $stamp, $Profile)
$encoding = [System.Text.UTF8Encoding]::new($false)

[System.IO.File]::WriteAllText(
  $resultPath,
  (($envelope | ConvertTo-Json -Depth 30) + [Environment]::NewLine),
  $encoding
)
[System.IO.File]::WriteAllText($logPath, $allOutput + [Environment]::NewLine, $encoding)

Push-Location $benchmarkRoot
try {
  & node ./scripts/summarize.mjs $resultPath
  if ($LASTEXITCODE -ne 0) { throw "Summary generation failed" }
}
finally {
  Pop-Location
}

Write-Host "Raw result: $resultPath"
Write-Host "Summary: $(Join-Path $benchmarkRoot 'results/summary.md')"
