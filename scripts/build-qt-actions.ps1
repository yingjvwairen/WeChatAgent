param([switch]$SelfTest, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'QT_COMPILER_UNAVAILABLE' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'state\ui-host' }
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'QT_OUTPUT_DIRECTORY_INVALID' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$arguments = @('/nologo','/target:exe','/platform:x64','/optimize+','/warn:4','/main:WechatQtActions',('/out:' + (Join-Path $OutputDirectory 'WechatQtActions.exe')))
foreach ($reference in @('System.Web.Extensions.dll','System.Windows.Forms.dll','System.Drawing.dll','System.Xml.dll','WPF\WindowsBase.dll','WPF\UIAutomationClient.dll','WPF\UIAutomationTypes.dll')) { $arguments += '/reference:' + (Join-Path $framework $reference) }
foreach ($source in @('native-ui\WechatDraftProbe.cs','native-ui\WechatFocusSafety.cs','native-ui\WechatUiaCaptionGeometry.cs','native-ui\WechatOffscreenActivationClient.cs','native-ui\WechatWindowMessageInput.cs','native-ui\WechatQtActions.cs','native-ui\WechatQtReturnCaption.cs','native-ui\WechatQtLayoutCapture.cs','native-ui\WechatQtImagePaste.cs','native-ui\WechatQtUiaGeometry.cs','native-ui\WechatQtUiaControls.cs','native-ui\WechatQtQuote.cs','native-ui\WechatQtQuoteOcr.cs','native-ui\WechatQtUiaPointer.cs','native-ui\WechatQtUiaBackgroundText.cs')) { $arguments += Join-Path $PSScriptRoot $source }
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'QT_BUILD_FAILED' }
if ($SelfTest) { & (Join-Path $OutputDirectory 'WechatQtActions.exe') --self-test; if ($LASTEXITCODE -ne 0) { throw 'QT_SELFTEST_FAILED' } }
Write-Output 'Qt actions built. No application was accessed and no input was sent.'
