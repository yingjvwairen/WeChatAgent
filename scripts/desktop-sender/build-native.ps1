param([switch]$SelfTest, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'state\ui-host' }
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'DESKTOP_OUTPUT_DIRECTORY_INVALID' }
foreach ($builder in @('build-qt-actions.ps1','build-voice-probe.ps1','build-background-controls.ps1','build-account-probe.ps1','build-visual-probe.ps1','build-quote-history.ps1','build-uia-offscreen-host.ps1','build-offscreen-focus.ps1','build-window-message-probe.ps1')) {
    & (Join-Path $PSScriptRoot $builder) -OutputDirectory $OutputDirectory -SelfTest:$SelfTest
}
& (Join-Path (Split-Path -Parent $PSScriptRoot) 'build-audio-probe.ps1') -OutputDirectory $OutputDirectory -SelfTest:$SelfTest
Write-Output 'Desktop sender built. No live application input, recording or device changes were performed.'
