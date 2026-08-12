[CmdletBinding()]
param(
  [ValidateSet("volume", "branches")][string]$Profile = "volume",
  [ValidateRange(10, 30)][int]$Iterations = 10,
  [int]$Seed = 20260809
)

$ErrorActionPreference = "Stop"
$scriptRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$batchId = "$Profile-" + [DateTimeOffset]::UtcNow.ToString("yyyyMMddHHmmss")
$random = [System.Random]::new($Seed)

for ($trial = 1; $trial -le $Iterations; $trial++) {
  $pairId = "$batchId-$($trial.ToString('D2'))"
  $order = if ($random.Next(0, 2) -eq 0) { @("baseline", "c3") } else { @("c3", "baseline") }
  Write-Host "[$trial/$Iterations] $pairId order: $($order -join ' -> ')"
  for ($orderIndex = 0; $orderIndex -lt $order.Count; $orderIndex++) {
    $variant = $order[$orderIndex]
    if ($Profile -eq "branches") {
      & powershell -ExecutionPolicy Bypass -File (Join-Path $scriptRoot "run-branches.ps1") `
        -Variant $variant -BatchId $batchId -PairId $pairId -Trial $trial `
        -BenchmarkSeed $Seed -OrderIndex $orderIndex -SkipReport
    } else {
      & powershell -ExecutionPolicy Bypass -File (Join-Path $scriptRoot "run-variant.ps1") `
        -Variant $variant -Profile volume -BatchId $batchId -PairId $pairId -Trial $trial `
        -BenchmarkSeed $Seed -OrderIndex $orderIndex
    }
    if ($LASTEXITCODE -ne 0) { throw "$variant $Profile trial $trial failed" }
  }
}

& node (Join-Path $scriptRoot "report-paired.mjs") $Profile $batchId
if ($LASTEXITCODE -ne 0) { throw "paired report generation failed" }
Write-Host "Paired benchmark complete: $batchId"
