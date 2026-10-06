<#
  Cài Native Messaging host cho Video Grabber (Windows).

  Cách dùng (PowerShell, tại thư mục native-host):
    .\install.ps1 -ExtensionId <ID extension ở chrome://extensions>
    .\install.ps1 -ExtensionId <ID> -InstallDeps     # cài luôn yt-dlp + ffmpeg bằng winget
    .\install.ps1 -Uninstall
#>
param(
  [string]$ExtensionId,
  [switch]$InstallDeps,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$HostName = 'com.videograbber.ytdlp'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ManifestPath = Join-Path $Dir "$HostName.json"
$BatPath = Join-Path $Dir 'vg_host.bat'
$Keys = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"
)

if ($Uninstall) {
  foreach ($k in $Keys) { if (Test-Path $k) { Remove-Item $k -Recurse -Force } }
  Remove-Item $ManifestPath, $BatPath -ErrorAction SilentlyContinue
  Write-Host 'Đã gỡ native host.'
  exit 0
}

if (-not $ExtensionId) { throw 'Thiếu -ExtensionId (xem ở chrome://extensions, bật Developer mode).' }

$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) { $py = (Get-Command py -ErrorAction SilentlyContinue).Source }
if (-not $py) { throw 'Không tìm thấy Python trong PATH.' }

if ($InstallDeps) {
  if (-not (Get-Command yt-dlp -ErrorAction SilentlyContinue)) { winget install -e --id yt-dlp.yt-dlp }
  if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { winget install -e --id Gyan.FFmpeg }
}

# Chrome trên Windows chỉ chạy được exe/bat -> dùng file .bat gọi Python
$bat = "@echo off`r`n`"$py`" `"$Dir\vg_host.py`" %*`r`n"
[IO.File]::WriteAllText($BatPath, $bat, [Text.Encoding]::ASCII)

$manifest = [ordered]@{
  name            = $HostName
  description     = 'Video Grabber - yt-dlp bridge'
  path            = $BatPath
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
[IO.File]::WriteAllText($ManifestPath, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))

foreach ($k in $Keys) {
  New-Item -Path $k -Force | Out-Null
  Set-ItemProperty -Path $k -Name '(default)' -Value $ManifestPath
}

Write-Host "Đã đăng ký host '$HostName' cho extension $ExtensionId"
Write-Host "Python : $py"
Write-Host ("yt-dlp : " + $(if (Get-Command yt-dlp -ErrorAction SilentlyContinue) { 'OK' } else { 'CHƯA CÀI (winget install yt-dlp.yt-dlp)' }))
Write-Host ("ffmpeg : " + $(if (Get-Command ffmpeg -ErrorAction SilentlyContinue) { 'OK' } else { 'CHƯA CÀI (winget install Gyan.FFmpeg)' }))
Write-Host 'Reload extension rồi thử lại.'
