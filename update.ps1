param(
  [string]$Source = "D:\Wow\World of Warcraft 3.3.5a\WTF\Account\ISUPERFRESH\SavedVariables\SoftResRoller.lua",
  [string]$AddonData = "D:\Wow\World of Warcraft 3.3.5a\Interface\AddOns\SoftResRoller\SoftResRollerData.lua"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Source)) {
  throw "SoftResRoller.lua was not found: $Source"
}

$assetsDir = Join-Path $PSScriptRoot "assets"
if (-not (Test-Path -LiteralPath $assetsDir)) {
  New-Item -ItemType Directory -Path $assetsDir | Out-Null
}

$lua = [string](Get-Content -LiteralPath $Source -Raw)
$defaultCsv = ""
if (Test-Path -LiteralPath $AddonData) {
  $addonText = [string](Get-Content -LiteralPath $AddonData -Raw)
  $match = [regex]::Match($addonText, "SoftResRollerDefaultCsv\s*=\s*\[\[(?<csv>[\s\S]*?)\]\]")
  if ($match.Success) {
    $defaultCsv = $match.Groups["csv"].Value.Trim()
  }
}
$payload = [ordered]@{
  generatedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  source = $Source
  addonData = $AddonData
  defaultCsv = $defaultCsv
  lua = $lua
}

$json = $payload | ConvertTo-Json -Depth 4 -Compress
$target = Join-Path $assetsDir "data.js"
Set-Content -LiteralPath $target -Value "window.SOFTRES_PAYLOAD = $json;" -Encoding UTF8

Write-Host "Updated $target"
