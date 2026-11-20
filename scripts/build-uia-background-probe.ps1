param([switch]$SelfTest, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'UIA_BG_COMPILER_UNAVAILABLE' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'state\ui-host' }
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'UIA_BG_OUTPUT_DIRECTORY_INVALID' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$output = Join-Path $OutputDirectory 'WechatUiaBackgroundProbe.exe'
$arguments = @('/nologo','/target:exe','/platform:x64','/optimize+','/warn:4',('/out:' + $output))
foreach ($reference in @('System.Web.Extensions.dll','WPF\WindowsBase.dll','WPF\UIAutomationClient.dll','WPF\UIAutomationTypes.dll')) {
    $referencePath = Join-Path $framework $reference
    if (-not (Test-Path -LiteralPath $referencePath -PathType Leaf)) { throw 'UIA_BG_REFERENCE_MISSING' }
    $arguments += '/reference:' + $referencePath
}
$arguments += Join-Path $PSScriptRoot 'native-ui\WechatUiaBackgroundProbe.cs'
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'UIA_BG_BUILD_FAILED' }
if ($SelfTest) { & $output --self-test; if ($LASTEXITCODE -ne 0) { throw 'UIA_BG_SELFTEST_FAILED' } }
Write-Output ('Restricted background UIA probe built: ' + $output)
