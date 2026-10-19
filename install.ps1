# claude-sidekicks installer for Windows.
#   .\install.ps1              install or update
#   .\install.ps1 --uninstall  remove everything again
# If Windows blocks the script: powershell -ExecutionPolicy Bypass -File install.ps1
# No admin rights needed: it only edits config files in your user folder.
# The real work happens in install.mjs; this just finds Node.
$ErrorActionPreference = "Stop"
if (-not $PSScriptRoot) {
  Write-Host "Run this as a file (.\install.ps1) from inside the project folder."
  exit 1
}
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) {
  Write-Host "node not found. Install Node.js 18 or newer: https://nodejs.org"
  exit 1
}
& $node.Source (Join-Path $PSScriptRoot "install.mjs") @args
exit $LASTEXITCODE
