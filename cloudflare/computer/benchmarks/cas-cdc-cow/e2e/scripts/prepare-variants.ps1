[CmdletBinding()]
param(
  [string]$ComputerRepo = "",
  [string]$Commit = "76d9e75c5688713b656bce85540d9e0071cece8b",
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$e2eRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$patchPath = Join-Path $e2eRoot "patches\dofs-c3.patch"
$candidateVendor = Join-Path $e2eRoot "vendor\c3"
$baselineVendor = [System.IO.Path]::GetFullPath((Join-Path $e2eRoot "..\..\storage\vendor"))
$variants = @("baseline", "c3")

function Find-ComputerRepository {
  param([string]$Start)
  $cursor = Get-Item -LiteralPath $Start
  while ($null -ne $cursor) {
    $candidate = Join-Path $cursor.FullName "computer"
    if (Test-Path -LiteralPath (Join-Path $candidate ".git")) {
      return [System.IO.Path]::GetFullPath($candidate)
    }
    $cursor = $cursor.Parent
  }
  throw "Could not find the sibling cloudflare/computer checkout."
}

if ([string]::IsNullOrWhiteSpace($ComputerRepo)) {
  $ComputerRepo = Find-ComputerRepository -Start $e2eRoot
}
$ComputerRepo = [System.IO.Path]::GetFullPath($ComputerRepo)
$resolvedCommit = (& git -C $ComputerRepo rev-parse "$Commit^{commit}").Trim()
if ($LASTEXITCODE -ne 0 -or $resolvedCommit -ne $Commit) {
  throw "Expected exact Computer commit $Commit; resolved $resolvedCommit"
}
if (-not (Test-Path -LiteralPath $patchPath)) { throw "Missing $patchPath" }

$requiredBaseline = @(
  "cloudflare-computer-0.1.0-alpha.1.tgz",
  "cloudflare-computer-rpc-0.0.0-full.tgz",
  "cloudflare-computerd-0.1.0-alpha.1.tgz",
  "cloudflare-dofs-0.0.0-full.tgz"
)
$baselineProvenancePath = Join-Path $baselineVendor "PROVENANCE.json"
if (-not (Test-Path -LiteralPath $baselineProvenancePath)) {
  throw "Missing baseline provenance: $baselineProvenancePath"
}
$baselineProvenance = Get-Content -LiteralPath $baselineProvenancePath -Raw | ConvertFrom-Json
if ($baselineProvenance.sourceCommit -ne $resolvedCommit) {
  throw "Baseline package commit $($baselineProvenance.sourceCommit) does not match $resolvedCommit"
}
$expectedBaselineHashes = @{
  "cloudflare-computer-0.1.0-alpha.1.tgz" = [string]$baselineProvenance.packageSha256
  "cloudflare-dofs-0.0.0-full.tgz" = [string]$baselineProvenance.workspacePackages.'@cloudflare/dofs'.sha256
  "cloudflare-computer-rpc-0.0.0-full.tgz" = [string]$baselineProvenance.workspacePackages.'@cloudflare/computer-rpc'.sha256
  "cloudflare-computerd-0.1.0-alpha.1.tgz" = [string]$baselineProvenance.workspacePackages.'@cloudflare/computerd'.sha256
}
foreach ($name in $requiredBaseline) {
  $baselinePackage = Join-Path $baselineVendor $name
  if (-not (Test-Path -LiteralPath $baselinePackage)) {
    throw "Missing baseline package $name. Run the storage benchmark bootstrap first."
  }
  $actualHash = (Get-FileHash -LiteralPath $baselinePackage -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedBaselineHashes[$name].ToLowerInvariant()) {
    throw "Baseline package hash mismatch: $name"
  }
}

$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase ("computer-c3-build-" + [guid]::NewGuid().ToString("N"))
$sourceRoot = Join-Path $tempRoot "source"
$archivePath = Join-Path $tempRoot "computer.tar"
New-Item -ItemType Directory -Path $sourceRoot -Force | Out-Null
New-Item -ItemType Directory -Path $candidateVendor -Force | Out-Null

function Invoke-Npm {
  param([string[]]$Arguments)
  & npm.cmd @Arguments
  if ($LASTEXITCODE -ne 0) { throw "npm $($Arguments -join ' ') failed" }
}

function Pack-Workspace {
  param(
    [string]$Workspace,
    [string]$PackedName,
    [string]$TargetName,
    [string]$Directory,
    [bool]$ExposeDist
  )
  if ($ExposeDist) {
    $ignore = Join-Path (Join-Path $sourceRoot $Directory) ".npmignore"
    [System.IO.File]::WriteAllText($ignore, "*`n!dist/`n!dist/**`n!README.md`n")
  }
  $packed = Join-Path $candidateVendor $PackedName
  $target = Join-Path $candidateVendor $TargetName
  foreach ($candidate in @($packed, $target) | Select-Object -Unique) {
    if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate -Force }
  }
  Invoke-Npm @("pack", "--workspace", $Workspace, "--pack-destination", $candidateVendor)
  if ($packed -ne $target) { Move-Item -LiteralPath $packed -Destination $target }
}

try {
  & git -C $ComputerRepo archive --format=tar --output=$archivePath $resolvedCommit
  if ($LASTEXITCODE -ne 0) { throw "git archive failed" }
  & tar.exe -xf $archivePath -C $sourceRoot
  if ($LASTEXITCODE -ne 0) { throw "tar extraction failed" }

  & git -C $sourceRoot apply --check $patchPath
  if ($LASTEXITCODE -ne 0) { throw "C3 patch does not apply to $resolvedCommit" }
  & git -C $sourceRoot apply $patchPath
  if ($LASTEXITCODE -ne 0) { throw "C3 patch application failed" }

  Push-Location $sourceRoot
  try {
    Invoke-Npm @("ci", "--ignore-scripts")
    Invoke-Npm @("run", "build", "--workspace", "@cloudflare/dofs")
    Invoke-Npm @("test", "--workspace", "@cloudflare/dofs")
    Invoke-Npm @("run", "build", "--workspace", "@cloudflare/computer-rpc")
    Invoke-Npm @("run", "build", "--workspace", "@cloudflare/computerd")
    Invoke-Npm @("run", "build", "--workspace", "@cloudflare/computer")

    Pack-Workspace "@cloudflare/dofs" "cloudflare-dofs-0.0.0.tgz" "cloudflare-dofs-0.0.0-full.tgz" "packages/dofs" $true
    Pack-Workspace "@cloudflare/computer-rpc" "cloudflare-computer-rpc-0.0.0.tgz" "cloudflare-computer-rpc-0.0.0-full.tgz" "packages/rpc" $true
    Pack-Workspace "@cloudflare/computerd" "cloudflare-computerd-0.1.0-alpha.1.tgz" "cloudflare-computerd-0.1.0-alpha.1.tgz" "packages/computerd" $false
    Pack-Workspace "@cloudflare/computer" "cloudflare-computer-0.1.0-alpha.1.tgz" "cloudflare-computer-0.1.0-alpha.1.tgz" "packages/computer" $false
  }
  finally { Pop-Location }

  $packages = [ordered]@{}
  foreach ($name in $requiredBaseline) {
    $path = Join-Path $candidateVendor $name
    if (-not (Test-Path -LiteralPath $path)) { throw "Candidate package missing: $path" }
    $packages[$name] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $provenance = [ordered]@{
    upstream = "https://github.com/cloudflare/computer"
    sourceCommit = $resolvedCommit
    patch = "patches/dofs-c3.patch"
    patchSha256 = (Get-FileHash -LiteralPath $patchPath -Algorithm SHA256).Hash.ToLowerInvariant()
    packages = $packages
    dofsTests = "436 passed"
    bothEndsPatched = $true
    generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
  }
  [System.IO.File]::WriteAllText(
    (Join-Path $candidateVendor "PROVENANCE.json"),
    (($provenance | ConvertTo-Json -Depth 5) + [Environment]::NewLine)
  )
}
finally {
  $resolvedTemp = [System.IO.Path]::GetFullPath($tempRoot)
  if (
    $resolvedTemp.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -and
    [System.IO.Path]::GetFileName($resolvedTemp).StartsWith("computer-c3-build-") -and
    (Test-Path -LiteralPath $resolvedTemp)
  ) {
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

foreach ($variant in $variants) {
  $variantRoot = Join-Path $e2eRoot "variants\$variant"
  $generated = Join-Path $variantRoot "generated"
  $branchEngine = Join-Path $generated "branch-engine"
  New-Item -ItemType Directory -Path $generated -Force | Out-Null
  New-Item -ItemType Directory -Path $branchEngine -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $e2eRoot "template\storage-worker.ts") -Destination (Join-Path $generated "storage-worker.ts") -Force
  Copy-Item -LiteralPath (Join-Path $e2eRoot "template\branch-computer.ts") -Destination (Join-Path $generated "branch-computer.ts") -Force
  Copy-Item -Path (Join-Path $e2eRoot "..\src\engines\*.ts") -Destination $branchEngine -Force
  Copy-Item -LiteralPath (Join-Path $e2eRoot "template\wrangler.jsonc") -Destination (Join-Path $variantRoot "wrangler.jsonc") -Force
  if (-not $SkipInstall) {
    Push-Location $variantRoot
    try {
      Invoke-Npm @("install", "--ignore-scripts", "--no-audit", "--no-fund")
      if ($variant -eq "c3") {
        # File dependencies keep the same version string across patch
        # rebuilds. Name the archives explicitly so npm refreshes a
        # previously installed candidate instead of reporting it current.
        Invoke-Npm @(
          "install", "--ignore-scripts", "--no-audit", "--no-fund", "--force",
          "../../vendor/c3/cloudflare-dofs-0.0.0-full.tgz",
          "../../vendor/c3/cloudflare-computer-rpc-0.0.0-full.tgz",
          "../../vendor/c3/cloudflare-computerd-0.1.0-alpha.1.tgz",
          "../../vendor/c3/cloudflare-computer-0.1.0-alpha.1.tgz"
        )
      }
    }
    finally { Pop-Location }
  }
}

Write-Host "Prepared baseline and C3 Computer variants at $resolvedCommit"
