$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath "./node_modules")) {
  npm.cmd install
}

npm.cmd run typecheck
npm.cmd test

$benchmarkOutput = cmd.exe /d /c "npm.cmd run bench:scale 2>&1"
if ($LASTEXITCODE -ne 0) {
  throw "Edit-scale benchmark failed with exit code $LASTEXITCODE"
}
$benchmarkOutput | ForEach-Object { Write-Host $_ }

$marker = "EDIT_SCALE_JSON:"
$jsonLine = $benchmarkOutput | Where-Object { $_ -like "*$marker*" } | Select-Object -Last 1
if ($null -eq $jsonLine) {
  throw "Benchmark did not emit $marker"
}
$text = [string]$jsonLine
$json = $text.Substring($text.IndexOf($marker) + $marker.Length)
$null = $json | ConvertFrom-Json

New-Item -ItemType Directory -Path "./results" -Force | Out-Null
[System.IO.File]::WriteAllText(
  (Join-Path (Get-Location) "results/edit-scale-latest.json"),
  $json,
  [System.Text.UTF8Encoding]::new($false)
)
npm.cmd run report:scale

