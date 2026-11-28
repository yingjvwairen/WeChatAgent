param([string]$ExpectedExecutable = '')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$settings=Get-Content -LiteralPath (Join-Path $projectRoot 'config/wechatagent.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($settings.runtime.sender -ne 'wechat-ui') { throw 'DESKTOP_BACKEND_REQUIRED' }
$clientPath=[string]$settings.input.wechatExecutable
if (-not $clientPath) { throw 'DESKTOP_CLIENT_REQUIRED' }
if (-not [IO.Path]::IsPathRooted($clientPath)) { $clientPath=Join-Path $projectRoot $clientPath }
$clientPath=[IO.Path]::GetFullPath($clientPath)
if ($ExpectedExecutable -and -not [string]::Equals($clientPath, [IO.Path]::GetFullPath($ExpectedExecutable), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'DESKTOP_CLIENT_CHANGED'
}
if (-not (Test-Path -LiteralPath $clientPath -PathType Leaf)) { throw 'DESKTOP_CLIENT_REQUIRED' }
$version=(Get-Item -LiteralPath $clientPath).VersionInfo.FileVersion.Trim()
$profile=Get-Content -LiteralPath (Join-Path $projectRoot 'release-profile.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$expected=[string]$profile.wechatVersion
if (-not $expected -or $version -ne $expected -or ($null -ne $settings.input.expectedVersion -and $expected -ne $settings.input.expectedVersion)) {
    throw 'DESKTOP_VERSION_UNSUPPORTED'
}
if (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $clientPath) 'version.dll')) { throw 'DESKTOP_CLIENT_PROXY_PRESENT' }
$instances=@(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe' OR Name='WeChat.exe'")
$selected=@($instances | Where-Object {$_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $clientPath})
if ($selected.Count) { Write-Output 'Selected WeChat is already running; use its existing window.'; exit 0 }
if ($instances.Count) { throw 'DESKTOP_OTHER_WECHAT_RUNNING' }
$signature=Get-AuthenticodeSignature -LiteralPath $clientPath
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Tencent') { throw 'DESKTOP_CLIENT_SIGNATURE_INVALID' }
# This explicit UI action opens the actual interactive client, never a sender DLL.
Start-Process -FilePath $clientPath -WorkingDirectory (Split-Path -Parent $clientPath) -WindowStyle Normal | Out-Null
Write-Output 'Selected WeChat opened.'
