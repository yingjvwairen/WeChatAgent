param([switch]$SelfTest, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework 4.x x64 compiler is required.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root 'state\ui-host' }
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'DESKTOP_OUTPUT_DIRECTORY_INVALID' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$output = Join-Path $OutputDirectory 'AudioRouteProbe.exe'
$source = Join-Path $PSScriptRoot 'desktop-sender\native-audio\AudioRouteProbe.cs'
$waveSource = Join-Path $PSScriptRoot 'desktop-sender\native-audio\WavCablePlayback.cs'
$references = @('System.Web.Extensions.dll','System.Windows.Forms.dll','System.Drawing.dll') | ForEach-Object {
    '/reference:' + (Join-Path $framework $_)
}
& $compiler /nologo /target:exe /platform:x64 /optimize+ /warn:4 /main:AudioRouteProbe @references ('/out:' + $output) $source $waveSource
if ($LASTEXITCODE -ne 0) { throw 'Audio probe compilation failed.' }
if ($SelfTest) {
    & $output --self-test
    if ($LASTEXITCODE -ne 0) { throw 'Audio probe self-test failed.' }
}
Write-Output ('Audio probe built: ' + $output)
Write-Output 'No audio was played or recorded. Use --list for read-only endpoint discovery.'
