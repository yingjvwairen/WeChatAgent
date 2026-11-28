param([switch]$SelfTest, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root 'state\ui-host' }
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'QUOTE_UIA_OUTPUT_INVALID' }
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$output = Join-Path $OutputDirectory 'WechatQuoteHistory.exe'
$arguments = @('/nologo','/target:exe','/platform:x64','/optimize+','/warn:4',('/out:' + $output))
foreach ($assembly in @('System.Web.Extensions.dll','System.Drawing.dll','WPF\WindowsBase.dll','WPF\UIAutomationClient.dll','WPF\UIAutomationTypes.dll')) {
    $arguments += '/reference:' + (Join-Path $framework $assembly)
}
foreach ($source in @('WechatQuoteHistory.cs','WechatQuoteHistoryNavigation.cs')) { $arguments += Join-Path $PSScriptRoot ('native-ui\' + $source) }
& (Join-Path $framework 'csc.exe') @arguments
if ($LASTEXITCODE -ne 0) { throw 'QUOTE_UIA_BUILD_FAILED' }
if ($SelfTest) { & $output --self-test; if ($LASTEXITCODE -ne 0) { throw 'QUOTE_UIA_SELFTEST_FAILED' } }
Write-Output 'History navigation helper built; no application was accessed.'
