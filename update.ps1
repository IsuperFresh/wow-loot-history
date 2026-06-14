param(
  [string]$Source = "D:\Wow\World of Warcraft 3.3.5a\WTF\Account\ISUPERFRESH\SavedVariables\SoftResRoller.lua",
  [string]$AddonData = "D:\Wow\World of Warcraft 3.3.5a\Interface\AddOns\SoftResRoller\SoftResRollerData.lua",
  [switch]$RefreshAttendance
)

$ErrorActionPreference = "Stop"
$AttendanceMinDamageOrHealing = 100000
$AttendanceCacheVersion = "min-activity-100000-v2"

if (-not (Test-Path -LiteralPath $Source)) {
  throw "SoftResRoller.lua was not found: $Source"
}

function ConvertFrom-LuaString {
  param([string]$Value)
  if ($null -eq $Value) { return "" }
  return ($Value -replace '\\"','"' -replace '\\\\','\')
}

function ConvertFrom-HtmlText {
  param([string]$Value)
  if ($null -eq $Value) { return "" }
  $text = [regex]::Replace($Value, "<script[\s\S]*?</script>", "", "IgnoreCase")
  $text = [regex]::Replace($text, "<style[\s\S]*?</style>", "", "IgnoreCase")
  $text = [regex]::Replace($text, "<[^>]+>", " ")
  $text = [System.Net.WebUtility]::HtmlDecode($text)
  return (($text -replace '\s+', ' ').Trim())
}

function ConvertTo-Number {
  param([string]$Value)
  $raw = ([string]$Value).Trim().ToLowerInvariant()
  $multiplier = 1.0
  if ($raw -match '([kmb])\s*$') {
    if ($Matches[1] -eq "k") { $multiplier = 1000.0 }
    elseif ($Matches[1] -eq "m") { $multiplier = 1000000.0 }
    elseif ($Matches[1] -eq "b") { $multiplier = 1000000000.0 }
  }
  $clean = ($raw -replace '[^\d\.,-]', '') -replace ' ', ''
  if ([string]::IsNullOrWhiteSpace($clean)) { return 0 }
  if ($clean.Contains(".") -and $clean.Contains(",")) {
    $clean = $clean -replace ',', ''
  } elseif ($clean -match '^-?\d{1,3}(,\d{3})+(\.\d+)?$') {
    $clean = $clean -replace ',', ''
  } else {
    $clean = $clean -replace ',', '.'
  }
  $number = 0.0
  if ([double]::TryParse($clean, [Globalization.NumberStyles]::Any, [Globalization.CultureInfo]::InvariantCulture, [ref]$number)) {
    return $number * $multiplier
  }
  return 0
}

function Get-UwuColumnIndex {
  param(
    [string[]]$Headers,
    [string[]]$Needles,
    [int]$Fallback
  )

  for ($index = 0; $index -lt $Headers.Count; $index++) {
    $header = ([string]$Headers[$index]).Trim().ToLowerInvariant()
    foreach ($needle in $Needles) {
      if ($header -eq $needle -or $header -match [regex]::Escape($needle)) {
        return $index
      }
    }
  }

  return $Fallback
}

function ConvertTo-EnglishRequestError {
  param([System.Exception]$ErrorObject)

  if ($ErrorObject -is [System.Net.WebException]) {
    $response = $ErrorObject.Response
    if ($response) {
      $statusCode = [int]$response.StatusCode
      $statusText = [string]$response.StatusDescription
      if ([string]::IsNullOrWhiteSpace($statusText)) {
        $statusText = [string]$response.StatusCode
      }
      return "HTTP $statusCode $statusText"
    }

    if ($ErrorObject.Status) {
      return "Request failed: $($ErrorObject.Status)"
    }
  }

  if ($ErrorObject.Message) {
    return "Request failed: $($ErrorObject.Message)"
  }

  return "Request failed"
}

function Invoke-UwuRequest {
  param([string]$Url)

  $currentUrl = $Url
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    try {
      return Invoke-WebRequest -Uri $currentUrl -UseBasicParsing -TimeoutSec 30 -MaximumRedirection 5 -Headers @{
        "User-Agent" = "Mozilla/5.0 SoftResRoller attendance updater"
      }
    } catch [System.Net.WebException] {
      $response = $_.Exception.Response
      $statusCode = if ($response) { [int]$response.StatusCode } else { 0 }
      $location = if ($response) { $response.Headers["Location"] } else { "" }
      if (($statusCode -eq 301 -or $statusCode -eq 302 -or $statusCode -eq 307 -or $statusCode -eq 308) -and $location) {
        $base = [Uri]$currentUrl
        $currentUrl = ([Uri]::new($base, $location)).AbsoluteUri
        continue
      }
      if ($statusCode -eq 429 -and $attempt -lt 4) {
        $retryAfter = 0
        if ($response -and [int]::TryParse($response.Headers["Retry-After"], [ref]$retryAfter) -and $retryAfter -gt 0) {
          Start-Sleep -Seconds ([Math]::Min($retryAfter, 20))
        } else {
          Start-Sleep -Seconds (3 + ($attempt * 2))
        }
        continue
      }
      throw (ConvertTo-EnglishRequestError $_.Exception)
    }
  }

  throw "Too many redirects for $Url"
}

function Get-RaidLogUrls {
  param([string]$LuaText)
  $urls = [ordered]@{}
  $match = [regex]::Match($LuaText, '\["raidLogUrls"\]\s*=\s*\{(?<body>[\s\S]*?)\n\t\}', 'Singleline')
  if (-not $match.Success) { return $urls }
  foreach ($entry in [regex]::Matches($match.Groups["body"].Value, '\["(?<id>(?:\\.|[^"])*)"\]\s*=\s*"(?<url>(?:\\.|[^"])*)"')) {
    $id = ConvertFrom-LuaString $entry.Groups["id"].Value
    $url = ConvertFrom-LuaString $entry.Groups["url"].Value
    if ($id -and $url) { $urls[$id] = $url }
  }
  return $urls
}

function Get-UwuAttendance {
  param(
    [string]$RaidId,
    [string]$Url,
    [string]$Title = "",
    [string]$Phase = "",
    [string]$Source = "addon"
  )

  $record = [ordered]@{
    raidId = $RaidId
    title = $Title
    phase = $Phase
    source = $Source
    url = $Url
    fetchedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    players = @()
    skipped = @()
    performance = @()
    minDamageOrHealing = $AttendanceMinDamageOrHealing
    error = ""
  }

  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $response = Invoke-UwuRequest -Url $Url
    $html = [string]$response.Content
    $seen = @{}
    $headers = @()
    foreach ($row in [regex]::Matches($html, '<tr[\s\S]*?</tr>', 'IgnoreCase')) {
      $cells = @()
      foreach ($cell in [regex]::Matches($row.Value, '<t[dh][^>]*>(?<cell>[\s\S]*?)</t[dh]>', 'IgnoreCase')) {
        $cells += ConvertFrom-HtmlText $cell.Groups["cell"].Value
      }
      if ($cells.Count -lt 4) { continue }
      $name = $cells[0]
      if (-not $name -or $name -eq "Total") { continue }
      if ($name -eq "Name") {
        $headers = $cells
        continue
      }

      $dpsIndex = Get-UwuColumnIndex -Headers $headers -Needles @("dps", "damage per second") -Fallback 3
      $damageDoneIndex = Get-UwuColumnIndex -Headers $headers -Needles @("damage done", "dmg done", "total damage") -Fallback 4
      $hpsIndex = Get-UwuColumnIndex -Headers $headers -Needles @("hps", "healing per second") -Fallback 9
      $healingDoneIndex = Get-UwuColumnIndex -Headers $headers -Needles @("healing done", "heal done", "total healing") -Fallback 10
      $damageTakenIndex = Get-UwuColumnIndex -Headers $headers -Needles @("damage taken", "dmg taken", "taken") -Fallback 13
      $dps = if ($cells.Count -gt $dpsIndex) { ConvertTo-Number $cells[$dpsIndex] } else { 0 }
      $damageDone = if ($cells.Count -gt $damageDoneIndex) { ConvertTo-Number $cells[$damageDoneIndex] } else { 0 }
      $hps = if ($cells.Count -gt $hpsIndex) { ConvertTo-Number $cells[$hpsIndex] } else { 0 }
      $healingDone = if ($cells.Count -gt $healingDoneIndex) { ConvertTo-Number $cells[$healingDoneIndex] } else { 0 }
      $damageTaken = if ($cells.Count -gt $damageTakenIndex) { ConvertTo-Number $cells[$damageTakenIndex] } else { 0 }
      $record.performance += [ordered]@{
        name = $name
        dps = $dps
        hps = $hps
        damageDone = $damageDone
        healingDone = $healingDone
        damageTaken = $damageTaken
      }
      if ($damageDone -ge $AttendanceMinDamageOrHealing -or $healingDone -ge $AttendanceMinDamageOrHealing -or $damageTaken -ge $AttendanceMinDamageOrHealing) {
        if (-not $seen.ContainsKey($name)) {
          $record.players += $name
          $seen[$name] = $true
        }
      } else {
        $record.skipped += $name
      }
    }
  } catch {
    $record.error = ConvertTo-EnglishRequestError $_.Exception
  }

  $record.playerCount = @($record.players).Count
  return $record
}

function Get-StaticAttendanceLogs {
  $path = Join-Path $PSScriptRoot "attendance-logs.json"
  if (-not (Test-Path -LiteralPath $path)) { return @() }
  $json = [string](Get-Content -LiteralPath $path -Raw)
  if ([string]::IsNullOrWhiteSpace($json)) { return @() }
  $items = $json | ConvertFrom-Json
  foreach ($item in $items) {
    Write-Output $item
  }
}

$assetsDir = Join-Path $PSScriptRoot "assets"
if (-not (Test-Path -LiteralPath $assetsDir)) {
  New-Item -ItemType Directory -Path $assetsDir | Out-Null
}

$script:attendanceCachePath = Join-Path $PSScriptRoot "attendance-cache.json"
$script:attendanceCache = @{}
$script:attendanceCacheChanged = $false
$script:lastAttendanceFromCache = $false
if (Test-Path -LiteralPath $script:attendanceCachePath) {
  $cacheText = [string](Get-Content -LiteralPath $script:attendanceCachePath -Raw)
  if (-not [string]::IsNullOrWhiteSpace($cacheText)) {
    $cacheObject = $cacheText | ConvertFrom-Json
    foreach ($property in $cacheObject.PSObject.Properties) {
      $script:attendanceCache[$property.Name] = $property.Value
    }
  }
}

function Get-AttendanceCacheKey {
  param([string]$Url)
  return "$AttendanceCacheVersion|" + (ConvertFrom-LuaString $Url).Trim().TrimEnd("/").ToLowerInvariant()
}

function New-AttendanceRecordFromCache {
  param(
    $Cached,
    [string]$RaidId,
    [string]$Url,
    [string]$Title = "",
    [string]$Phase = "",
    [string]$Source = "addon"
  )

  $players = @($Cached.players)
  $skipped = @($Cached.skipped)
  $performance = if ($null -ne $Cached.performance) { @($Cached.performance) } else { @() }
  return [ordered]@{
    raidId = $RaidId
    title = $Title
    phase = $Phase
    source = $Source
    url = $Url
    fetchedAt = [string]$Cached.fetchedAt
    players = $players
    skipped = $skipped
    performance = $performance
    minDamageOrHealing = $AttendanceMinDamageOrHealing
    error = ""
    playerCount = $players.Count
  }
}

function Test-CachedAttendanceReady {
  param($Cached)
  if (-not $Cached -or $Cached.error) { return $false }
  if (@($Cached.players).Count -le 0) { return $false }
  $performance = @($Cached.performance)
  if ($performance.Count -le 0) { return $false }
  return [bool]($performance | Where-Object {
    $_.dps -gt 0 -or $_.hps -gt 0 -or $_.damageDone -gt 0
  } | Select-Object -First 1)
}

function Get-CachedOrFetchAttendance {
  param(
    [string]$RaidId,
    [string]$Url,
    [string]$Title = "",
    [string]$Phase = "",
    [string]$Source = "addon",
    [string]$Message = "attendance"
  )

  $cacheKey = Get-AttendanceCacheKey $Url
  $cached = if ($script:attendanceCache.ContainsKey($cacheKey)) { $script:attendanceCache[$cacheKey] } else { $null }
  if ((-not $RefreshAttendance -and $cached -and -not $cached.error -and @($cached.players).Count -gt 0) -or (Test-CachedAttendanceReady $cached)) {
    Write-Host "Using cached $Message`: $Url"
    $script:lastAttendanceFromCache = $true
    return New-AttendanceRecordFromCache -Cached $cached -RaidId $RaidId -Url $Url -Title $Title -Phase $Phase -Source $Source
  }

  if ($cached) {
    Write-Host "Fetching missing performance for $Message`: $Url"
  } else {
    Write-Host "Fetching new $Message`: $Url"
  }
  $script:lastAttendanceFromCache = $false
  $record = Get-UwuAttendance -RaidId $RaidId -Url $Url -Title $Title -Phase $Phase -Source $Source
  if (-not $record.error -and @($record.players).Count -gt 0) {
    $script:attendanceCache[$cacheKey] = [ordered]@{
      url = $Url
      fetchedAt = $record.fetchedAt
      players = @($record.players)
      skipped = @($record.skipped)
      performance = @($record.performance)
      minDamageOrHealing = $AttendanceMinDamageOrHealing
      playerCount = @($record.players).Count
      error = ""
    }
    $script:attendanceCacheChanged = $true
  } elseif ($cached -and -not $cached.error -and @($cached.players).Count -gt 0) {
    Write-Host "Keeping cached $Message after fetch error: $Url"
    $script:lastAttendanceFromCache = $true
    return New-AttendanceRecordFromCache -Cached $cached -RaidId $RaidId -Url $Url -Title $Title -Phase $Phase -Source $Source
  }
  return $record
}

$lua = [string](Get-Content -LiteralPath $Source -Raw)
$raidLogUrls = Get-RaidLogUrls $lua
$attendance = @()
foreach ($key in $raidLogUrls.Keys) {
  $url = [string]$raidLogUrls[$key]
  if (-not [string]::IsNullOrWhiteSpace($url)) {
    $attendance += Get-CachedOrFetchAttendance -RaidId $key -Url $url -Message "attendance"
  }
}

foreach ($log in Get-StaticAttendanceLogs) {
    $url = [string]$log.url
  if (-not [string]::IsNullOrWhiteSpace($url)) {
    $id = [string]$log.id
    if ([string]::IsNullOrWhiteSpace($id)) { $id = $url }
    $attendance += Get-CachedOrFetchAttendance -RaidId $id -Url $url -Title ([string]$log.title) -Phase ([string]$log.phase) -Source "static" -Message "static attendance"
    if (-not $script:lastAttendanceFromCache) {
      Start-Sleep -Milliseconds 750
    }
  }
}

if ($script:attendanceCacheChanged -or $RefreshAttendance) {
  $cacheJson = $script:attendanceCache | ConvertTo-Json -Depth 8
  Set-Content -LiteralPath $script:attendanceCachePath -Value $cacheJson -Encoding UTF8
  Write-Host "Updated attendance cache: $script:attendanceCachePath"
}

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
  attendance = $attendance
  lua = $lua
}

$json = $payload | ConvertTo-Json -Depth 8 -Compress
$target = Join-Path $assetsDir "data.js"
Set-Content -LiteralPath $target -Value "window.SOFTRES_PAYLOAD = $json;" -Encoding UTF8

Write-Host "Updated $target"
