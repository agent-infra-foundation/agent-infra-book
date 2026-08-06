[CmdletBinding()]
param(
  [string]$ComputerRepo = "",
  [string]$Commit = "76d9e75c5688713b656bce85540d9e0071cece8b",
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$benchmarkRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

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

  throw "Could not find a sibling cloudflare/computer checkout. Pass -ComputerRepo explicitly."
}

if ([string]::IsNullOrWhiteSpace($ComputerRepo)) {
  $ComputerRepo = Find-ComputerRepository -Start $benchmarkRoot
}
$ComputerRepo = [System.IO.Path]::GetFullPath($ComputerRepo)

if (-not (Test-Path -LiteralPath (Join-Path $ComputerRepo ".git"))) {
  throw "Not a Git checkout: $ComputerRepo"
}

$resolvedCommit = (& git -C $ComputerRepo rev-parse "$Commit^{commit}").Trim()
if ($LASTEXITCODE -ne 0 -or $resolvedCommit -ne $Commit) {
  throw "Expected exact Computer commit $Commit; resolved $resolvedCommit"
}

$packageJsonRef = "{0}:packages/computer/package.json" -f $resolvedCommit
$packageJsonText = & git -C $ComputerRepo show $packageJsonRef
if ($LASTEXITCODE -ne 0) {
  throw "Could not read packages/computer/package.json at $resolvedCommit"
}
$packageJson = $packageJsonText | ConvertFrom-Json
$packageVersion = [string]$packageJson.version
$expectedArchive = "cloudflare-computer-{0}.tgz" -f $packageVersion

function Read-PackageVersionAtCommit {
  param([string]$RelativePackageJson)

  $ref = "{0}:{1}" -f $resolvedCommit, $RelativePackageJson
  $text = & git -C $ComputerRepo show $ref
  if ($LASTEXITCODE -ne 0) {
    throw "Could not read $RelativePackageJson at $resolvedCommit"
  }
  return [string](($text | ConvertFrom-Json).version)
}

$dofsVersion = Read-PackageVersionAtCommit "packages/dofs/package.json"
$rpcVersion = Read-PackageVersionAtCommit "packages/rpc/package.json"
$computerdVersion = Read-PackageVersionAtCommit "packages/computerd/package.json"
$additionalPackages = @(
  [ordered]@{
    workspace = "@cloudflare/dofs"
    file = "cloudflare-dofs-$dofsVersion-full.tgz"
    packedFile = "cloudflare-dofs-$dofsVersion.tgz"
    directory = "packages/dofs"
    exposeBuiltDist = $true
  },
  [ordered]@{
    workspace = "@cloudflare/computer-rpc"
    file = "cloudflare-computer-rpc-$rpcVersion-full.tgz"
    packedFile = "cloudflare-computer-rpc-$rpcVersion.tgz"
    directory = "packages/rpc"
    exposeBuiltDist = $true
  },
  [ordered]@{
    workspace = "@cloudflare/computerd"
    file = "cloudflare-computerd-$computerdVersion.tgz"
    packedFile = "cloudflare-computerd-$computerdVersion.tgz"
    directory = "packages/computerd"
    exposeBuiltDist = $false
  }
)

$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = Join-Path $tempBase ("computer-benchmark-" + [guid]::NewGuid().ToString("N"))
$sourceRoot = Join-Path $tempRoot "source"
$archivePath = Join-Path $tempRoot "computer.tar"
$vendorRoot = Join-Path $benchmarkRoot "vendor"
$packagePath = Join-Path $vendorRoot $expectedArchive

New-Item -ItemType Directory -Path $sourceRoot -Force | Out-Null
New-Item -ItemType Directory -Path $vendorRoot -Force | Out-Null

try {
  & git -C $ComputerRepo archive --format=tar --output=$archivePath $resolvedCommit
  if ($LASTEXITCODE -ne 0) {
    throw "git archive failed"
  }

  & tar.exe -xf $archivePath -C $sourceRoot
  if ($LASTEXITCODE -ne 0) {
    throw "tar extraction failed"
  }

  Push-Location $sourceRoot
  try {
    & npm.cmd ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }

    & npm.cmd run build --workspace @cloudflare/dofs
    if ($LASTEXITCODE -ne 0) { throw "@cloudflare/dofs build failed" }

    & npm.cmd run build --workspace @cloudflare/computer-rpc
    if ($LASTEXITCODE -ne 0) { throw "@cloudflare/computer-rpc build failed" }

    & npm.cmd run build --workspace @cloudflare/computerd
    if ($LASTEXITCODE -ne 0) { throw "@cloudflare/computerd build failed" }

    & npm.cmd run build --workspace @cloudflare/computer
    if ($LASTEXITCODE -ne 0) { throw "@cloudflare/computer build failed" }

    foreach ($spec in $additionalPackages) {
      if ($spec.exposeBuiltDist) {
        # These private workspaces export dist/ but do not declare a files list.
        # npm pack otherwise inherits the repository's dist ignore and creates an
        # unusable source-only tarball. The allowlist is applied only inside the
        # clean temporary git archive after the upstream build has completed.
        $npmIgnorePath = Join-Path (Join-Path $sourceRoot $spec.directory) ".npmignore"
        [System.IO.File]::WriteAllText(
          $npmIgnorePath,
          ("*`n!dist/`n!dist/**`n!README.md`n"),
          [System.Text.UTF8Encoding]::new($false)
        )
      }

      $candidate = [System.IO.Path]::GetFullPath((Join-Path $vendorRoot $spec.file))
      if (-not $candidate.StartsWith(
        [System.IO.Path]::GetFullPath($vendorRoot),
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
        throw "Refusing to replace package outside benchmark vendor directory"
      }
      if (Test-Path -LiteralPath $candidate) {
        Remove-Item -LiteralPath $candidate -Force
      }
      $packedCandidate = [System.IO.Path]::GetFullPath((Join-Path $vendorRoot $spec.packedFile))
      if (
        $packedCandidate -ne $candidate -and
        (Test-Path -LiteralPath $packedCandidate)
      ) {
        Remove-Item -LiteralPath $packedCandidate -Force
      }
      & npm.cmd pack --workspace $spec.workspace --pack-destination $vendorRoot | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "npm pack failed for $($spec.workspace)" }
      if ($packedCandidate -ne $candidate) {
        Move-Item -LiteralPath $packedCandidate -Destination $candidate
      }
    }

    if (Test-Path -LiteralPath $packagePath) {
      $resolvedPackagePath = [System.IO.Path]::GetFullPath($packagePath)
      if (-not $resolvedPackagePath.StartsWith(
        [System.IO.Path]::GetFullPath($vendorRoot),
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
        throw "Refusing to replace package outside benchmark vendor directory"
      }
      Remove-Item -LiteralPath $resolvedPackagePath -Force
    }

    & npm.cmd pack --workspace @cloudflare/computer --pack-destination $vendorRoot | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "npm pack failed" }
  }
  finally {
    Pop-Location
  }

  if (-not (Test-Path -LiteralPath $packagePath)) {
    throw "Expected package was not produced: $packagePath"
  }
  foreach ($spec in $additionalPackages) {
    $candidate = Join-Path $vendorRoot $spec.file
    if (-not (Test-Path -LiteralPath $candidate)) {
      throw "Expected package was not produced: $candidate"
    }
  }

  $sourceCommitDate = (& git -C $ComputerRepo show -s --format=%cI $resolvedCommit).Trim()
  $packageSha256 = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $workspacePackages = [ordered]@{}
  foreach ($spec in $additionalPackages) {
    $candidate = Join-Path $vendorRoot $spec.file
    $workspacePackages[$spec.workspace] = [ordered]@{
      file = $spec.file
      sha256 = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  $provenance = [ordered]@{
    upstream = "https://github.com/cloudflare/computer"
    sourceCommit = $resolvedCommit
    sourceCommitDate = $sourceCommitDate
    packageName = "@cloudflare/computer"
    packageVersion = $packageVersion
    packageFile = $expectedArchive
    packageSha256 = $packageSha256
    workspacePackages = $workspacePackages
    sourceMode = "git-archive"
    workspacePackaging = "built-dist-allowlist-for-private-packages"
    dirtyWorkingTreeIncluded = $false
    generatedAt = [DateTimeOffset]::UtcNow.ToString("o")
  }
  $provenancePath = Join-Path $vendorRoot "PROVENANCE.json"
  [System.IO.File]::WriteAllText(
    $provenancePath,
    (($provenance | ConvertTo-Json -Depth 5) + [Environment]::NewLine),
    [System.Text.UTF8Encoding]::new($false)
  )

  if (-not $SkipInstall) {
    Push-Location $benchmarkRoot
    try {
      # fuse-native is loaded by Linux/WSL for this benchmark. Running package
      # lifecycle scripts on Windows would attempt an irrelevant Windows build.
      & npm.cmd install --ignore-scripts --prefer-offline --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw "benchmark npm install failed" }
    }
    finally {
      Pop-Location
    }
  }

  Write-Host "Prepared $packagePath"
  Write-Host "Source commit: $resolvedCommit"
  Write-Host "Package SHA-256: $packageSha256"
}
finally {
  $resolvedTemp = [System.IO.Path]::GetFullPath($tempRoot)
  if (
    $resolvedTemp.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -and
    [System.IO.Path]::GetFileName($resolvedTemp).StartsWith("computer-benchmark-")
  ) {
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
