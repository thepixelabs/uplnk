#Requires -Version 5.1
<#
.SYNOPSIS
    Installs uplnk on Windows.

.DESCRIPTION
    Downloads the latest uplnk Windows binary from GitHub Releases and installs
    it to $env:LOCALAPPDATA\Programs\uplnk\, then adds that directory to the
    current user's PATH if not already present.

.PARAMETER Version
    Specific version to install (e.g. "0.3.1" or "v0.3.1").
    Defaults to the latest GitHub release.

.PARAMETER InstallDir
    Override the install directory.
    Defaults to $env:LOCALAPPDATA\Programs\uplnk\.

.PARAMETER Force
    Skip the "already installed" prompt and always upgrade.

.EXAMPLE
    iwr https://uplnk.pixelabs.net/install.ps1 | iex

.EXAMPLE
    iwr https://uplnk.pixelabs.net/install.ps1 -OutFile install.ps1
    .\install.ps1 -Version 0.3.1 -Force
#>

[CmdletBinding()]
param(
    [string] $Version    = $env:UPLNK_VERSION,
    [string] $InstallDir = $env:UPLNK_INSTALL_DIR,
    [switch] $Force      = ($env:UPLNK_FORCE -eq "1")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

$GithubRepo   = "thepixelabs/uplnk"
$ReleasesUrl  = "https://github.com/$GithubRepo/releases"
$GithubApi    = "https://api.github.com/repos/$GithubRepo/releases/latest"
$BinaryLeaf   = "uplnk-win-x64.exe"
$BinaryName   = "uplnk.exe"

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

function Write-Info    { param([string]$Msg) Write-Host "  ==>  $Msg" -ForegroundColor Cyan    }
function Write-Ok      { param([string]$Msg) Write-Host "  OK   $Msg" -ForegroundColor Green   }
function Write-Warn    { param([string]$Msg) Write-Host "  WARN $Msg" -ForegroundColor Yellow  }
function Write-Err     { param([string]$Msg) Write-Host "  ERR  $Msg" -ForegroundColor Red     }
function Invoke-Die    {
    param([string]$Msg)
    Write-Err $Msg
    exit 1
}

# ---------------------------------------------------------------------------
# Version resolution
# ---------------------------------------------------------------------------

function Get-LatestVersion {
    Write-Info "Resolving latest release from GitHub..."
    try {
        $response = Invoke-RestMethod -Uri $GithubApi -UseBasicParsing -Headers @{ "User-Agent" = "uplnk-installer" }
        $tag = $response.tag_name
        if (-not $tag) { Invoke-Die "Could not parse tag_name from GitHub API response." }
        return $tag.TrimStart("v")
    }
    catch {
        Invoke-Die "Could not reach GitHub API: $_`n  Check your network connection and try again."
    }
}

# ---------------------------------------------------------------------------
# Checksum verification
# ---------------------------------------------------------------------------

function Test-Checksum {
    param([string]$FilePath, [string]$ChecksumFile)

    $expected = (Get-Content $ChecksumFile -Raw).Trim().Split()[0]
    $actual   = (Get-FileHash -Algorithm SHA256 -Path $FilePath).Hash.ToLower()
    $expected = $expected.ToLower()

    if ($expected -ne $actual) {
        Write-Err "Checksum mismatch!"
        Write-Err "  Expected: $expected"
        Write-Err "  Actual:   $actual"
        return $false
    }

    Write-Ok "Checksum verified."
    return $true
}

# ---------------------------------------------------------------------------
# Already-installed check
# ---------------------------------------------------------------------------

function Test-ExistingInstall {
    $existing = Get-Command uplnk -ErrorAction SilentlyContinue
    if (-not $existing) { return }

    $currentVer = & uplnk --version 2>$null | Select-Object -First 1
    if (-not $currentVer) { $currentVer = "unknown" }

    Write-Host ""
    Write-Warn "uplnk is already installed: $currentVer"
    Write-Host ""

    if ($Force) {
        Write-Info "-Force specified — upgrading without prompt."
        return
    }

    $answer = Read-Host "  Upgrade to the latest version? [y/N]"
    if ($answer -notmatch '^[yY]') {
        Write-Info "Skipped. Re-run with -Force to upgrade without prompting."
        exit 0
    }
}

# ---------------------------------------------------------------------------
# Install directory
# ---------------------------------------------------------------------------

function Resolve-InstallDir {
    if ($InstallDir) { return $InstallDir }
    if (-not $env:LOCALAPPDATA) {
        Invoke-Die "LOCALAPPDATA environment variable is not set. Use -InstallDir to specify an install path."
    }
    return Join-Path $env:LOCALAPPDATA "Programs\uplnk"
}

# ---------------------------------------------------------------------------
# PATH helper
# ---------------------------------------------------------------------------

function Add-ToUserPath {
    param([string]$Dir)

    $currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    # Filter empty segments: GetEnvironmentVariable returns "" (not $null) when
    # the User PATH key exists but is empty. Splitting "" yields @(""), and
    # joining back with ";" would produce a leading semicolon in the new PATH.
    $pathParts = @($currentPath -split ";" | Where-Object { $_ -ne "" })

    if ($pathParts -contains $Dir) {
        Write-Info "$Dir is already in your PATH."
        return
    }

    Write-Info "Adding $Dir to user PATH..."
    $newPath = ($pathParts + $Dir) -join ";"
    [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")

    # Also update the current session so the verify step can find the binary
    $env:PATH = "$env:PATH;$Dir"

    Write-Ok "PATH updated. You may need to restart your terminal for it to take effect."
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

function Main {
    Write-Host ""
    Write-Host "  uplnk installer" -ForegroundColor White
    Write-Host "  https://github.com/$GithubRepo"
    Write-Host ""

    # 1. Resolve version
    if ($Version) {
        $resolvedVersion = $Version.TrimStart("v")
        Write-Info "Using requested version: $resolvedVersion"
    }
    else {
        $resolvedVersion = Get-LatestVersion
        Write-Info "Latest version: $resolvedVersion"
    }

    # 2. Check for existing install
    Test-ExistingInstall

    # 3. Resolve install directory
    $targetDir = Resolve-InstallDir
    Write-Info "Install directory: $targetDir"

    if (-not (Test-Path $targetDir)) {
        Write-Info "Creating directory: $targetDir"
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    }

    # 4. Build download URL
    $downloadUrl  = "$ReleasesUrl/download/v$resolvedVersion/$BinaryLeaf"
    $checksumUrl  = "$downloadUrl.sha256"
    # Use a unique temp directory to avoid collisions from concurrent installs or
    # stale partial downloads left by a previously interrupted install.
    $tmpDir       = Join-Path $env:TEMP "uplnk-install-$resolvedVersion-$([System.IO.Path]::GetRandomFileName())"
    $tmpBinary    = Join-Path $tmpDir $BinaryLeaf
    $tmpChecksum  = Join-Path $tmpDir "$BinaryLeaf.sha256"

    New-Item -ItemType Directory -Path $tmpDir | Out-Null

    # 5. Download binary
    Write-Info "Downloading $BinaryLeaf v$resolvedVersion..."
    try {
        Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpBinary -UseBasicParsing
    }
    catch {
        Invoke-Die "Download failed: $_`n  URL: $downloadUrl`n  Check that v$resolvedVersion exists: $ReleasesUrl"
    }

    # 6. Attempt checksum verification (non-fatal if sidecar missing)
    Write-Info "Downloading checksum file..."
    try {
        Invoke-WebRequest -Uri $checksumUrl -OutFile $tmpChecksum -UseBasicParsing
        if (-not (Test-Checksum -FilePath $tmpBinary -ChecksumFile $tmpChecksum)) {
            Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
            Invoke-Die "Checksum verification failed. The download may be corrupt or tampered with."
        }
    }
    catch {
        Write-Warn "No checksum file found at $checksumUrl — skipping verification."
        Write-Warn "Consider reporting this to the uplnk maintainers."
    }

    # 7. Install
    $destPath = Join-Path $targetDir $BinaryName
    Write-Info "Installing to $destPath..."
    Copy-Item $tmpBinary $destPath -Force
    Write-Ok "Installed $destPath"

    # 8. Clean up temp files
    Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue

    # 9. Update PATH
    Add-ToUserPath -Dir $targetDir

    # 10. Smoke test
    Write-Info "Verifying installation..."
    try {
        $ver = & $destPath --version 2>$null | Select-Object -First 1
        if (-not $ver) { $ver = "(installed)" }
        Write-Ok "uplnk $ver is ready."
    }
    catch {
        Write-Warn "uplnk was installed but '$destPath --version' failed."
        Write-Warn "Please report this at: https://github.com/$GithubRepo/issues"
    }

    Write-Host ""
    Write-Host "  Next steps:" -ForegroundColor White
    Write-Host ""
    Write-Host "    uplnk doctor    # check provider connectivity"
    Write-Host "    uplnk           # start chatting"
    Write-Host "    uplnk --help    # full command reference"
    Write-Host ""
}

Main
