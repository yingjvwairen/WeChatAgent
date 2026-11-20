param([switch]$SelfTest, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'OFFSCREEN_COMPILER_UNAVAILABLE' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'state\diagnostics\uia-offscreen-probe' }
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'OFFSCREEN_OUTPUT_DIRECTORY_INVALID' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$arguments = @('/nologo','/target:exe','/platform:x64','/optimize+','/warn:4',('/out:' + (Join-Path $OutputDirectory 'WechatUiaOffscreenProbe.exe')))
foreach ($reference in @('System.Web.Extensions.dll','System.Windows.Forms.dll','System.Drawing.dll','WPF\WindowsBase.dll','WPF\UIAutomationClient.dll','WPF\UIAutomationTypes.dll')) { $arguments += '/reference:' + (Join-Path $framework $reference) }
$arguments += Join-Path $PSScriptRoot 'native-ui\WechatUiaOffscreenProbe.cs'
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'OFFSCREEN_BUILD_FAILED' }
if ($SelfTest) { & (Join-Path $OutputDirectory 'WechatUiaOffscreenProbe.exe') --self-test; if ($LASTEXITCODE -ne 0) { throw 'OFFSCREEN_SELFTEST_FAILED' } }
Write-Output 'Independent offscreen diagnostic built. No UI was accessed or moved.'
