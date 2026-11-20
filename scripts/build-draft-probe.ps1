param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'DRAFT_COMPILER_UNAVAILABLE' }
$outputDirectory = Join-Path $projectRoot 'state\ui-host'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$output = Join-Path $outputDirectory 'WechatDraftProbe.exe'
$references = @('System.Web.Extensions.dll','System.Windows.Forms.dll','System.Drawing.dll')
$arguments = @('/nologo','/target:exe','/platform:x64','/optimize+','/warn:4',('/out:' + $output))
foreach ($reference in $references) {
    $file = Join-Path $framework $reference
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'DRAFT_ASSEMBLY_UNAVAILABLE' }
    $arguments += '/reference:' + $file
}
$arguments += Join-Path $PSScriptRoot 'native-ui\WechatDraftProbe.cs'
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'DRAFT_BUILD_FAILED' }
if ($SelfTest) {
    & $output --self-test
    if ($LASTEXITCODE -ne 0) { throw 'DRAFT_SELFTEST_FAILED' }
}
Write-Output 'Draft probe built. Live selection and clipboard inspection require an explicit short-lived session.'
