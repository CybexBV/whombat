package winpc

// The scripts print one JSON object. Non-ASCII characters are escaped
// (\uXXXX) so the output doesn't depend on the console's code page, and
// times are UTC in RFC 3339.

// psPrelude is the start of every script.
const psPrelude = `$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
function Utc($t) { if ($t -is [datetime] -and $t.Year -gt 1601) { $t.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') } else { '' } }
function Out-Json($o) {
  $j = ConvertTo-Json -InputObject $o -Depth 6 -Compress
  [regex]::Replace($j, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
}
`

// factsScript reads Defender, Security Center, BitLocker and the physical
// disks with the partitions that put a drive letter on them.
const factsScript = psPrelude + `$o = [ordered]@{}
$mp = Get-MpComputerStatus
if ($mp) {
  $o.defender = [ordered]@{
    service = [bool]$mp.AMServiceEnabled
    antivirus = [bool]$mp.AntivirusEnabled
    realtime = [bool]$mp.RealTimeProtectionEnabled
    mode = [string]$mp.AMRunningMode
    tamper = $mp.IsTamperProtected
    signatures = Utc $mp.AntivirusSignatureLastUpdated
    quick_scan = Utc $mp.QuickScanEndTime
  }
}
$os = Get-CimInstance -ClassName Win32_OperatingSystem
if ($os -and $os.ProductType -eq 1) {
  $av = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct)
  if ($?) {
    $o.security_center = $true
    $o.antivirus = @($av | Where-Object { $_ } | ForEach-Object { [ordered]@{ name = [string]$_.displayName; state = [int64]$_.productState } })
  }
}
if ($os) { $o.system_drive = [string]$os.SystemDrive }
$bl = Get-CimInstance -Namespace root/cimv2/Security/MicrosoftVolumeEncryption -ClassName Win32_EncryptableVolume
if ($bl) {
  $o.bitlocker = @($bl | Where-Object { $_.DriveLetter } | ForEach-Object { [ordered]@{ drive = [string]$_.DriveLetter; protection = [int]$_.ProtectionStatus } })
}
$o.disks = @(Get-PhysicalDisk | ForEach-Object {
  $r = $_ | Get-StorageReliabilityCounter
  [ordered]@{
    id = [string]$_.DeviceId
    name = [string]$_.FriendlyName
    serial = ([string]$_.SerialNumber).Trim()
    media = [string]$_.MediaType
    bus = [string]$_.BusType
    size = [int64]$_.Size
    health = [string]$_.HealthStatus
    temp = $r.Temperature
    wear = $r.Wear
    hours = $r.PowerOnHours
    read_errors = $r.ReadErrorsUncorrected
    write_errors = $r.WriteErrorsUncorrected
  }
})
$o.partitions = @(Get-Partition | Where-Object { [string]$_.DriveLetter -match '^[A-Za-z]$' } | ForEach-Object { [ordered]@{ drive = [string]$_.DriveLetter; disk = [string]$_.DiskNumber } })
Out-Json $o
`

// updatesScript asks Windows Update for the updates waiting, from its own
// last check (Online false: no download of its own, no call to Microsoft),
// whether it needs a restart, and when it last checked and installed.
const updatesScript = psPrelude + `$o = [ordered]@{}
try {
  $s = New-Object -ComObject Microsoft.Update.Session
  $q = $s.CreateUpdateSearcher()
  $q.Online = $false
  $r = $q.Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
  $o.updates = @($r.Updates | ForEach-Object {
    [ordered]@{
      title = [string]$_.Title
      kb = @($_.KBArticleIDs | ForEach-Object { [string]$_ })
      severity = [string]$_.MsrcSeverity
      categories = @($_.Categories | ForEach-Object { [string]$_.CategoryID })
      size = [int64]$_.MaxDownloadSize
    }
  })
} catch { $o.error = [string]$_.Exception.Message }
try { $o.reboot = [bool](New-Object -ComObject Microsoft.Update.SystemInfo).RebootRequired } catch {}
try { $a = (New-Object -ComObject Microsoft.Update.AutoUpdate).Results } catch { $a = $null }
if ($a) {
  # Windows Update gives these in UTC without saying so.
  try { $o.searched = Utc ([datetime]::SpecifyKind($a.LastSearchSuccessDate, 'Utc')) } catch {}
  try { $o.installed = Utc ([datetime]::SpecifyKind($a.LastInstallationSuccessDate, 'Utc')) } catch {}
}
$o.cbs_reboot = Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'
$o.wu_reboot = Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
Out-Json $o
`
