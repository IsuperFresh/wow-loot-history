param(
  [string]$Source = "D:\wow-hd\world of warcraft 3.3.5a hd\WTF\Account\ISUPERFRESH\SavedVariables\SoftResRoller.lua",
  [string]$AddonData = "D:\wow-hd\world of warcraft 3.3.5a hd\interface\addons\SoftResRoller\SoftResRollerData.lua",
  [switch]$RefreshAttendance
)

$ErrorActionPreference = "Stop"
$AttendanceMinDamageOrHealing = 100000
$AttendanceCacheVersion = "min-activity-100000-boss-performance-v8"

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

function Get-HtmlClassList {
  param([string]$Attributes)
  $match = [regex]::Match($Attributes, 'class\s*=\s*["''](?<class>[^"'']+)["'']', 'IgnoreCase')
  if (-not $match.Success) { return @() }
  return @($match.Groups["class"].Value -split '\s+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Get-HtmlAttribute {
  param(
    [string]$Attributes,
    [string]$Name
  )

  $pattern = ('{0}\s*=\s*["''](?<value>[^"'']*)["'']' -f [regex]::Escape($Name))
  $match = [regex]::Match($Attributes, $pattern, 'IgnoreCase')
  if (-not $match.Success) { return "" }
  return [System.Net.WebUtility]::HtmlDecode($match.Groups["value"].Value).Trim()
}

function Get-UwuClassSpecFromTitle {
  param([string]$Title)

  $text = ([string]$Title).Trim()
  $classes = @(
    @{ Pattern = '\bDeath\s*Knight\b|\bDeathknight\b'; Name = 'Deathknight' },
    @{ Pattern = '\bPaladin\b'; Name = 'Paladin' },
    @{ Pattern = '\bShaman\b'; Name = 'Shaman' },
    @{ Pattern = '\bDruid\b'; Name = 'Druid' },
    @{ Pattern = '\bHunter\b'; Name = 'Hunter' },
    @{ Pattern = '\bMage\b'; Name = 'Mage' },
    @{ Pattern = '\bPriest\b'; Name = 'Priest' },
    @{ Pattern = '\bRogue\b'; Name = 'Rogue' },
    @{ Pattern = '\bWarlock\b'; Name = 'Warlock' },
    @{ Pattern = '\bWarrior\b'; Name = 'Warrior' }
  )

  foreach ($class in $classes) {
    $match = [regex]::Match($text, $class.Pattern, 'IgnoreCase')
    if ($match.Success) {
      $spec = ($text.Substring(0, $match.Index) -replace '\s+', ' ').Trim()
      return [pscustomobject]@{
        className = $class.Name
        spec = $spec
      }
    }
  }

  return [pscustomobject]@{
    className = ""
    spec = ""
  }
}

function Get-UwuCellIndex {
  param(
    [object[]]$Cells,
    [string[]]$RequiredClasses,
    [int]$Fallback
  )

  for ($index = 0; $index -lt $Cells.Count; $index++) {
    $classes = @($Cells[$index].classes)
    $matched = $true
    foreach ($required in $RequiredClasses) {
      if ($classes -notcontains $required) {
        $matched = $false
        break
      }
    }
    if ($matched) { return $index }
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


function Get-RaidPhases {
  param([string]$LuaText)
  $phases = [ordered]@{}
  $match = [regex]::Match($LuaText, '\["raidPhases"\]\s*=\s*\{(?<body>[\s\S]*?)\n\t\}', 'Singleline')
  if (-not $match.Success) { return $phases }
  foreach ($entry in [regex]::Matches($match.Groups["body"].Value, '\["(?<id>(?:\\.|[^"])*)"\]\s*=\s*"(?<phase>(?:\\.|[^"])*)"')) {
    $id = ConvertFrom-LuaString $entry.Groups["id"].Value
    $phase = ConvertFrom-LuaString $entry.Groups["phase"].Value
    if ($id -and $phase) { $phases[$id] = $phase }
  }
  return $phases
}
function Read-UwuPerformanceFromHtml {
  param([string]$Html)

  $result = [ordered]@{
    players = @()
    skipped = @()
    performance = @()
  }
  $seen = @{}
  foreach ($row in [regex]::Matches($Html, '<tr[\s\S]*?</tr>', 'IgnoreCase')) {
    $cells = @()
    foreach ($cell in [regex]::Matches($row.Value, '<t[dh](?<attrs>[^>]*)>(?<cell>[\s\S]*?)</t[dh]>', 'IgnoreCase')) {
      $title = Get-HtmlAttribute $cell.Groups["attrs"].Value "title"
      if (-not $title) { $title = Get-HtmlAttribute $cell.Groups["cell"].Value "title" }
      $cells += [pscustomobject]@{
        text = ConvertFrom-HtmlText $cell.Groups["cell"].Value
        classes = @(Get-HtmlClassList $cell.Groups["attrs"].Value)
        title = $title
      }
    }
    if ($cells.Count -lt 4) { continue }
    $name = [string]$cells[0].text
    if (-not $name -or $name -eq "Total" -or $name -eq "Name") { continue }
    $classSpec = Get-UwuClassSpecFromTitle $cells[0].title

    $dpsIndex = Get-UwuCellIndex -Cells $cells -RequiredClasses @("damage", "per-sec-cell") -Fallback 8
    $damageDoneIndex = Get-UwuCellIndex -Cells $cells -RequiredClasses @("damage", "total-cell") -Fallback 7
    $hpsIndex = Get-UwuCellIndex -Cells $cells -RequiredClasses @("heal", "per-sec-cell") -Fallback 11
    $healingDoneIndex = Get-UwuCellIndex -Cells $cells -RequiredClasses @("heal", "total-cell") -Fallback 10
    $damageTakenIndex = Get-UwuCellIndex -Cells $cells -RequiredClasses @("taken", "total-cell") -Fallback 16
    $damageTakenPerSecondIndex = Get-UwuCellIndex -Cells $cells -RequiredClasses @("taken", "per-sec-cell") -Fallback 17
    $dps = if ($cells.Count -gt $dpsIndex) { ConvertTo-Number $cells[$dpsIndex].text } else { 0 }
    $damageDone = if ($cells.Count -gt $damageDoneIndex) { ConvertTo-Number $cells[$damageDoneIndex].text } else { 0 }
    $hps = if ($cells.Count -gt $hpsIndex) { ConvertTo-Number $cells[$hpsIndex].text } else { 0 }
    $healingDone = if ($cells.Count -gt $healingDoneIndex) { ConvertTo-Number $cells[$healingDoneIndex].text } else { 0 }
    $damageTaken = if ($cells.Count -gt $damageTakenIndex) { ConvertTo-Number $cells[$damageTakenIndex].text } else { 0 }
    $damageTakenPerSecond = if ($cells.Count -gt $damageTakenPerSecondIndex) { ConvertTo-Number $cells[$damageTakenPerSecondIndex].text } else { 0 }
    $result.performance += [ordered]@{
      name = $name
      dps = $dps
      hps = $hps
      damageDone = $damageDone
      healingDone = $healingDone
      damageTaken = $damageTaken
      damageTakenPerSecond = $damageTakenPerSecond
      className = $classSpec.className
      spec = $classSpec.spec
    }
    if ($damageDone -ge $AttendanceMinDamageOrHealing -or $healingDone -ge $AttendanceMinDamageOrHealing -or $damageTaken -ge $AttendanceMinDamageOrHealing) {
      if (-not $seen.ContainsKey($name)) {
        $result.players += $name
        $seen[$name] = $true
      }
    } else {
      $result.skipped += $name
    }
  }
  return $result
}

function Get-UwuBossLinks {
  param(
    [string]$Html,
    [string]$BaseUrl
  )

  $bosses = @()
  foreach ($match in [regex]::Matches($Html, '<a\s+href="(?<href>[^"]+)"\s+class="kill-link">(?<text>[\s\S]*?)</a>', 'IgnoreCase')) {
    $text = ConvertFrom-HtmlText $match.Groups["text"].Value
    $parts = @($text -split '\s*\|\s*')
    if ($parts.Count -lt 3) { continue }
    $bosses += [ordered]@{
      name = $parts[2]
      mode = $parts[1]
      duration = $parts[0]
      url = ([Uri]::new([Uri]$BaseUrl, [System.Net.WebUtility]::HtmlDecode($match.Groups["href"].Value))).AbsoluteUri
    }
  }
  return $bosses
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
    bosses = @()
    bossCount = 0
    minDamageOrHealing = $AttendanceMinDamageOrHealing
    error = ""
  }

  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $response = Invoke-UwuRequest -Url $Url
    $html = [string]$response.Content
    $summary = Read-UwuPerformanceFromHtml $html
    $record.players = @($summary.players)
    $record.skipped = @($summary.skipped)
    $record.performance = @($summary.performance)
    $bossLinks = @(Get-UwuBossLinks -Html $html -BaseUrl $Url)
    $record.bossCount = $bossLinks.Count

    foreach ($bossLink in $bossLinks) {
      try {
        $bossResponse = Invoke-UwuRequest -Url $bossLink.url
        $bossSummary = Read-UwuPerformanceFromHtml ([string]$bossResponse.Content)
        $record.bosses += [ordered]@{
          name = $bossLink.name
          mode = $bossLink.mode
          duration = $bossLink.duration
          url = $bossLink.url
          players = @($bossSummary.players)
          skipped = @($bossSummary.skipped)
          performance = @($bossSummary.performance)
          error = ""
        }
      } catch {
        $record.bosses += [ordered]@{
          name = $bossLink.name
          mode = $bossLink.mode
          duration = $bossLink.duration
          url = $bossLink.url
          players = @()
          skipped = @()
          performance = @()
          error = ConvertTo-EnglishRequestError $_.Exception
        }
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
  $bosses = if ($null -ne $Cached.bosses) { @($Cached.bosses) } else { @() }
  $bossCount = if ($null -ne $Cached.bossCount) { [int]$Cached.bossCount } else { $bosses.Count }
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
    bosses = @($bosses)
    bossCount = $bossCount
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
  $hasRates = [bool]($performance | Where-Object {
    $_.dps -gt 0 -or $_.hps -gt 0
  } | Select-Object -First 1)
  $hasBossPerformance = [bool](@($Cached.bosses) | Where-Object {
    @($_.performance).Count -gt 0
  } | Select-Object -First 1)
  return $hasRates -and $Cached.bossCount -gt 0 -and $hasBossPerformance
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
      bosses = @($record.bosses)
      bossCount = $record.bossCount
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
$raidPhases = Get-RaidPhases $lua
$attendance = @()
foreach ($key in $raidLogUrls.Keys) {
  $url = [string]$raidLogUrls[$key]
  if (-not [string]::IsNullOrWhiteSpace($url)) {
    $attendance += Get-CachedOrFetchAttendance -RaidId $key -Url $url -Phase ([string]$raidPhases[$key]) -Message "attendance"
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


$archivePath = Join-Path $assetsDir "loot-archive.json"
$archiveTool = Join-Path $PSScriptRoot "archive-softres.js"
$archive = $null
if (Test-Path -LiteralPath $archiveTool) {
  $attendanceTemp = Join-Path ([System.IO.Path]::GetTempPath()) ("softres-attendance-" + [Guid]::NewGuid().ToString("N") + ".json")
  try {
    $attendance | ConvertTo-Json -Depth 12 -Compress | Set-Content -LiteralPath $attendanceTemp -Encoding UTF8
    & node $archiveTool $Source $archivePath $attendanceTemp
    if ($LASTEXITCODE -ne 0) { throw "archive-softres.js failed with exit code $LASTEXITCODE" }
    if (Test-Path -LiteralPath $archivePath) {
      $archiveText = [string](Get-Content -LiteralPath $archivePath -Raw)
      if (-not [string]::IsNullOrWhiteSpace($archiveText)) {
        $archive = $archiveText | ConvertFrom-Json
      }
    }
  } finally {
    if (Test-Path -LiteralPath $attendanceTemp) { Remove-Item -LiteralPath $attendanceTemp -Force }
  }
} else {
  Write-Warning "Archive helper not found: $archiveTool"
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
  archive = $archive
  lua = $lua
}

$json = $payload | ConvertTo-Json -Depth 8 -Compress
$target = Join-Path $assetsDir "data.js"
Set-Content -LiteralPath $target -Value "window.SOFTRES_PAYLOAD = $json;" -Encoding UTF8

Write-Host "Updated $target"

