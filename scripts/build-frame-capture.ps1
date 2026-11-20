param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework 4.x x64 compiler is required.' }
$outputDirectory = Join-Path $projectRoot 'state\ui-host'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$output = Join-Path $outputDirectory 'WechatFrameCapture.exe'
$references = @((Join-Path $framework 'System.Web.Extensions.dll'), (Join-Path $framework 'System.Drawing.dll'))
foreach ($reference in $references) {
    if (-not (Test-Path -LiteralPath $reference)) { throw ('Required Windows assembly is missing: ' + [IO.Path]::GetFileName($reference)) }
}
$arguments = @('/nologo','/target:exe','/platform:x64','/optimize+','/warn:4',('/out:' + $output))
$arguments += $references | ForEach-Object { '/reference:' + $_ }
$arguments += Join-Path $PSScriptRoot 'native-ui\WechatFrameCapture.cs'
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'Frame capture compilation failed.' }
if ($SelfTest) {
    & $output --self-test
    if ($LASTEXITCODE -ne 0) { throw 'Frame capture self-test failed.' }
}
Write-Output ('Frame capture built: ' + $output)
Write-Output 'Build/self-test never captures a desktop or sends input. Capture requires an explicit executable path and HWND.'
