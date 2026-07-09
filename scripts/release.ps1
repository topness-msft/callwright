<#
.SYNOPSIS
  Release callwright: bump version, test, commit/push, publish to npm + the MCP registry.

.DESCRIPTION
  Automates the deterministic release steps and drives the two interactive publishes
  (npm passkey 2FA + mcp-publisher GitHub device login). Run this in YOUR OWN terminal
  — the browser/passkey and device-code flows need a real TTY.

  Steps:
    1. Bump the version in package.json, server.json (x2), package-lock.json (x2) — in sync.
    2. Run the test suite (node --test). Skip with -SkipTests.
    3. Commit the version files and push to origin.
    4. npm publish            (passkey/web 2FA opens in your browser).
    5. mcp-publisher publish   (downloads the CLI + GitHub device login if needed).
    6. Verify npm + registry now serve the new version.

  Hosted (Fly) deploy and the Retell agent prompt push are intentionally NOT here —
  they are separate concerns (see notes at the end of the run).

.PARAMETER Version
  Explicit version, e.g. 1.0.4. If omitted, bumps the patch of the current version.

.PARAMETER SkipTests
  Skip the test run (not recommended).

.PARAMETER SkipRegistry
  Publish to npm only; skip the MCP registry step.

.EXAMPLE
  .\scripts\release.ps1                # bump patch, full release
  .\scripts\release.ps1 -Version 1.1.0 # explicit version
#>
[CmdletBinding()]
param(
  [string]$Version,
  [switch]$SkipTests,
  [switch]$SkipRegistry
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "OK  $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "ERR $msg" -ForegroundColor Red }

# --- 0. Resolve versions ---------------------------------------------------
$current = (Get-Content package.json -Raw | ConvertFrom-Json).version
if (-not $Version) {
  $p = $current.Split(".")
  $Version = "{0}.{1}.{2}" -f $p[0], $p[1], ([int]$p[2] + 1)
}
Step "Release $current -> $Version"
$confirm = Read-Host "Proceed? (y/N)"
if ($confirm -notin @("y", "Y")) { Fail "Aborted."; exit 1 }

# --- 1. Bump version in all files (JSON round-trip keeps them in sync) ------
Step "Bumping version to $Version"
$env:NEW_VER = $Version
$bump = @'
const fs = require("fs");
const v = process.env.NEW_VER;
function up(f, fn) {
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  fn(j);
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
}
up("package.json", (j) => { j.version = v; });
up("server.json", (j) => { j.version = v; if (j.packages && j.packages[0]) j.packages[0].version = v; });
up("package-lock.json", (j) => { j.version = v; if (j.packages && j.packages[""]) j.packages[""].version = v; });
console.log("bumped package.json, server.json, package-lock.json -> " + v);
'@
$bump | node -
if ($LASTEXITCODE -ne 0) { Fail "Version bump failed."; exit 1 }
Ok "Version files updated"

# --- 2. Tests --------------------------------------------------------------
if (-not $SkipTests) {
  Step "Running tests (node --test)"
  node --test
  if ($LASTEXITCODE -ne 0) { Fail "Tests failed — aborting release."; exit 1 }
  Ok "Tests passed"
} else {
  Write-Host "Skipping tests (-SkipTests)" -ForegroundColor Yellow
}

# --- 3. Commit + push ------------------------------------------------------
Step "Commit + push version bump"
git add package.json server.json package-lock.json
git commit -m "Release $Version"
if ($LASTEXITCODE -ne 0) { Fail "git commit failed (nothing to commit?)."; exit 1 }
git push origin HEAD
if ($LASTEXITCODE -ne 0) { Fail "git push failed."; exit 1 }
Ok "Pushed"

# --- 4. npm publish (interactive passkey / web 2FA) ------------------------
Step "npm publish (approve the passkey / 2FA in your browser)"
npm publish --auth-type=web
if ($LASTEXITCODE -ne 0) { Fail "npm publish failed."; exit 1 }
$npmLive = (npm view callwright version) 2>$null
if ($npmLive -eq $Version) { Ok "npm now serves $Version" } else { Fail "npm shows '$npmLive', expected '$Version'." }

# --- 5. MCP registry publish ----------------------------------------------
if (-not $SkipRegistry) {
  Step "Publishing to the MCP registry"
  $arch = if ($env:PROCESSOR_ARCHITECTURE -match "ARM64") { "arm64" } else { "amd64" }
  $pubDir = Join-Path $env:LOCALAPPDATA "mcp-publisher"
  $pub = Join-Path $pubDir "mcp-publisher.exe"
  if (-not (Test-Path $pub)) {
    Write-Host "Downloading mcp-publisher ($arch)..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path $pubDir | Out-Null
    $rel = Invoke-RestMethod "https://api.github.com/repos/modelcontextprotocol/registry/releases/latest"
    $asset = $rel.assets | Where-Object { $_.name -eq "mcp-publisher_windows_$arch.tar.gz" }
    $tgz = Join-Path $pubDir "mcp-publisher.tar.gz"
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tgz -UseBasicParsing
    tar -xzf $tgz -C $pubDir
    Remove-Item $tgz -ErrorAction SilentlyContinue
    Ok "mcp-publisher installed ($($rel.tag_name))"
  }

  # Try publish; if it fails (e.g. not authenticated), do the GitHub device login and retry.
  & $pub publish
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Not authenticated — starting GitHub device login (authorize as topness-msft)..." -ForegroundColor Yellow
    & $pub login github
    if ($LASTEXITCODE -ne 0) { Fail "mcp-publisher login failed."; exit 1 }
    & $pub publish
    if ($LASTEXITCODE -ne 0) { Fail "mcp-publisher publish failed."; exit 1 }
  }

  $reg = Invoke-RestMethod "https://registry.modelcontextprotocol.io/v0/servers?search=callwright"
  $versions = $reg.servers | ForEach-Object { $_.server.version }
  if ($versions -contains $Version) { Ok "MCP registry lists $Version" } else { Fail "Registry does not list $Version yet (versions: $($versions -join ', '))." }
} else {
  Write-Host "Skipping MCP registry (-SkipRegistry)" -ForegroundColor Yellow
}

# --- Done ------------------------------------------------------------------
Step "Release $Version complete"
Write-Host @"
Reminders (separate from npm/registry — do these if the change affects them):
  - Hosted server:  flyctl deploy         (ships server-side code to virtuphil)
  - Retell prompts: node update-prompt.js <agent_id> generic-prompt.md   (+ the .ja agent)
"@ -ForegroundColor DarkGray
