param([switch]$SelfTest, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'state\ui-host' }
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'DESKTOP_OUTPUT_DIRECTORY_INVALID' }
foreach ($builder in @('build-qt-actions.ps1','build-voice-probe.ps1','build-background-controls.ps1','build-account-probe.ps1','build-visual-probe.ps1','build-quote-history.ps1','build-uia-offscreen-host.ps1','build-offscreen-focus.ps1','build-window-message-probe.ps1')) {
    & (Join-Path $PSScriptRoot $builder) -OutputDirectory $OutputDirectory -SelfTest:$SelfTest
}
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
$audioOutput = Join-Path $OutputDirectory 'AudioRouteProbe.exe'
$arguments = @('/nologo','/target:exe','/platform:x64','/optimize+','/warn:4','/main:AudioRouteProbe',('/out:' + $audioOutput))
foreach ($reference in @('System.Web.Extensions.dll','System.Windows.Forms.dll','System.Drawing.dll')) { $arguments += '/reference:' + (Join-Path $framework $reference) }
foreach ($source in @('native-audio\AudioRouteProbe.cs','native-audio\WavCablePlayback.cs')) { $arguments += Join-Path $PSScriptRoot $source }
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'DESKTOP_AUDIO_BUILD_FAILED' }
if ($SelfTest) { & $audioOutput --self-test; if ($LASTEXITCODE -ne 0) { throw 'DESKTOP_AUDIO_SELFTEST_FAILED' } }
Write-Output 'Desktop sender built. No live application input, recording or device changes were performed.'
