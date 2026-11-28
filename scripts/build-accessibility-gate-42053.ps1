param([switch]$SelfTest, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'ACCESSIBILITY_COMPILER_UNAVAILABLE' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'state\ui-host' }
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'ACCESSIBILITY_OUTPUT_DIRECTORY_INVALID' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$output = Join-Path $OutputDirectory 'WechatAccessibilityGate42053.exe'
$arguments = @('/nologo','/target:exe','/platform:x64','/optimize+','/warn:4',('/out:' + $output),
    ('/reference:' + (Join-Path $framework 'System.Web.Extensions.dll')),
    (Join-Path $PSScriptRoot 'native-ui\WechatAccessibilityGate42053.cs'))
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'ACCESSIBILITY_BUILD_FAILED' }
if ($SelfTest) {
    & $output --self-test
    if ($LASTEXITCODE -ne 0) { throw 'ACCESSIBILITY_SELFTEST_FAILED' }
}
Write-Output '4.2.0.53 gate helper built. Build and self-tests do not access WeChat.'
