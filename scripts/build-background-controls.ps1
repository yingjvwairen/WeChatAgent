param([switch]$SelfTest, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'UI_CONTROLS_COMPILER_UNAVAILABLE' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'state\ui-host' }
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'UI_CONTROLS_OUTPUT_DIRECTORY_INVALID' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$output = Join-Path $OutputDirectory 'WechatBackgroundControls.exe'
$references = @('System.Web.Extensions.dll','WPF\WindowsBase.dll','WPF\UIAutomationClient.dll','WPF\UIAutomationTypes.dll')
$arguments = @('/nologo','/target:exe','/platform:x64','/optimize+','/warn:4',('/out:' + $output))
foreach ($reference in $references) {
    $referencePath = Join-Path $framework $reference
    if (-not (Test-Path -LiteralPath $referencePath -PathType Leaf)) { throw 'UI_CONTROLS_REFERENCE_MISSING' }
    $arguments += '/reference:' + $referencePath
}
$arguments += Join-Path $PSScriptRoot 'native-ui\WechatBackgroundControls.cs'
$arguments += Join-Path $PSScriptRoot 'native-ui\WechatBackgroundLayout.cs'
$arguments += Join-Path $PSScriptRoot 'native-ui\WechatBackgroundVerify.cs'
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'UI_CONTROLS_BUILD_FAILED' }
if ($SelfTest) { & $output --self-test; if ($LASTEXITCODE -ne 0) { throw 'UI_CONTROLS_SELFTEST_FAILED' } }
Write-Output ('Background control inspector built: ' + $output)
Write-Output 'Default inspection only reads UIA metadata. The search-write diagnostic requires an explicit mode and switch. This build opened or edited no application.'
