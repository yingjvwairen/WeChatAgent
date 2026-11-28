param([switch]$SelfTest, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'UI_ACCOUNT_COMPILER_UNAVAILABLE' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'state\ui-host' }
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'UI_ACCOUNT_OUTPUT_DIRECTORY_INVALID' }
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$output = Join-Path $outputDirectory 'WechatAccountProbe.exe'
$reference = Join-Path $framework 'System.Web.Extensions.dll'
if (-not (Test-Path -LiteralPath $reference -PathType Leaf)) { throw 'UI_ACCOUNT_ASSEMBLY_UNAVAILABLE' }
$arguments = @('/nologo','/target:exe','/platform:x64','/optimize+','/warn:4',('/out:' + $output),('/reference:' + $reference),(Join-Path $PSScriptRoot 'native-ui\WechatAccountProbe.cs'))
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'UI_ACCOUNT_BUILD_FAILED' }
if ($SelfTest) {
    & $output --self-test
    if ($LASTEXITCODE -ne 0) { throw 'UI_ACCOUNT_SELFTEST_FAILED' }
}
Write-Output 'Account probe built. It provides process/database snapshot evidence only and cannot enable UI input.'
