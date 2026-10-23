# User-scoped install of the built companion bundle on Windows. No admin rights, no Invoke-Expression.
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 install [-Autostart]
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 uninstall   (state is kept)
param([ValidateSet("install", "uninstall")][string]$Action = "install", [switch]$Autostart)
$ErrorActionPreference = "Stop"
$source = Join-Path $PSScriptRoot "..\output\ai-usage.cjs"
$targetDir = Join-Path $env:LOCALAPPDATA "Programs\ai-usage"
$target = Join-Path $targetDir "ai-usage.cjs"
$node = if ($env:AI_USAGE_NODE) { $env:AI_USAGE_NODE } else { (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
if (-not $node) { throw "Node.js 22.13+ not found; set AI_USAGE_NODE to node.exe's absolute path." }
if ($Action -eq "install") {
  if (-not (Test-Path -LiteralPath $source)) { throw "Build first: pnpm bundle" }
  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Force
  Write-Output "Installed $target"
  if ($Autostart) { & $node $target autostart install; if ($LASTEXITCODE) { exit $LASTEXITCODE }; & $node $target background }
  else { Write-Output "Next: & `"$node`" `"$target`" register <relay>; pair; then autostart install" }
} else {
  if (Test-Path -LiteralPath $target) {
    & $node $target autostart remove
    # Keep the bundle when autostart removal failed, so the Run entry never points at a missing file.
    if ($LASTEXITCODE) { Write-Error "Autostart removal failed; bundle kept."; exit $LASTEXITCODE }
  }
  Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
  Write-Output "Bundle removed. Companion state was kept; run revoke before deleting it manually. Stop a running companion via Task Manager or sign out."
}
