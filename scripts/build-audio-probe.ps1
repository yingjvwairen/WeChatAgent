param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework 4.x x64 compiler is required.' }
$outputDirectory = Join-Path $root 'state\audio-probe'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$output = Join-Path $outputDirectory 'AudioRouteProbe.exe'
$source = Join-Path $PSScriptRoot 'native-audio\AudioRouteProbe.cs'
$waveSource = Join-Path $PSScriptRoot 'native-audio\WavCablePlayback.cs'
$reference = Join-Path $framework 'System.Web.Extensions.dll'
& $compiler /nologo /target:exe /platform:x64 /optimize+ /warn:4 ('/reference:' + $reference) ('/out:' + $output) $source $waveSource
if ($LASTEXITCODE -ne 0) { throw 'Audio probe compilation failed.' }
if ($SelfTest) {
    & $output --self-test
    if ($LASTEXITCODE -ne 0) { throw 'Audio probe self-test failed.' }
}
Write-Output ('Audio probe built: ' + $output)
Write-Output 'No audio was played or recorded. Use --list for read-only endpoint discovery.'
