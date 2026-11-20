param([switch]$SelfTest, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'WM_PROBE_COMPILER_UNAVAILABLE' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'state\ui-host' }
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'WM_PROBE_OUTPUT_DIRECTORY_INVALID' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$output = Join-Path $OutputDirectory 'WechatWindowMessageProbe.exe'
$arguments = @('/nologo','/target:exe','/platform:x64','/optimize+','/warn:4',('/out:' + $output),('/reference:' + (Join-Path $framework 'System.Web.Extensions.dll')),('/reference:' + (Join-Path $framework 'System.Drawing.dll')),(Join-Path $PSScriptRoot 'native-ui\WechatWindowMessageProbe.cs'))
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'WM_PROBE_BUILD_FAILED' }
if ($SelfTest) { & $output --self-test; if ($LASTEXITCODE -ne 0) { throw 'WM_PROBE_SELFTEST_FAILED' } }
Write-Output 'Window message probe built. No desktop action was performed; live pointer messages require an explicit prepared request and switch.'
