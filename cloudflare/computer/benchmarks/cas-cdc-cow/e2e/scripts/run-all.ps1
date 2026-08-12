[CmdletBinding()]
param([ValidateSet("smoke", "volume")][string]$Profile = "smoke")

$ErrorActionPreference = "Stop"
$scriptRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
foreach ($variant in @("baseline", "c3")) {
  & powershell -ExecutionPolicy Bypass -File (Join-Path $scriptRoot "run-variant.ps1") -Variant $variant -Profile $Profile
  if ($LASTEXITCODE -ne 0) { throw "$variant benchmark failed" }
}
& node (Join-Path $scriptRoot "report.mjs") $Profile
if ($LASTEXITCODE -ne 0) { throw "report generation failed" }

