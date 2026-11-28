param([switch]$SelfTest, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'VOICE_COMPILER_UNAVAILABLE' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'state\ui-host' }
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'VOICE_OUTPUT_DIRECTORY_INVALID' }
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$output = Join-Path $outputDirectory 'WechatVoicePreview.exe'
$arguments = @('/nologo','/target:exe','/platform:x64','/optimize+','/warn:4','/main:WechatVoicePreview',('/out:' + $output))
$arguments += '/resource:' + (Join-Path $PSScriptRoot 'wechat-layout-templates.json') + ',WechatVoiceAdaptiveTemplates'
foreach ($reference in @('System.Web.Extensions.dll','System.Windows.Forms.dll','System.Drawing.dll','WPF\WindowsBase.dll','WPF\UIAutomationClient.dll','WPF\UIAutomationTypes.dll')) { $arguments += '/reference:' + (Join-Path $framework $reference) }
foreach ($source in @('native-ui\WechatDraftProbe.cs','native-ui\WechatWindowBinding.cs','native-ui\WechatClipboardSnapshot.cs','native-ui\WechatClipboardFormats.cs','native-ui\WechatFocusSafety.cs','native-ui\WechatUiaCaptionGeometry.cs','native-ui\WechatOffscreenActivationClient.cs','native-ui\WechatWindowMessageInput.cs','native-ui\WechatVoicePreview.cs','native-ui\WechatVoiceRequest.cs','native-ui\WechatVoiceWarmMonitor.cs','native-ui\RecordingAttempt.cs','native-ui\WechatVoiceFocusHandoff.cs','native-ui\WechatVoiceFocusSafety.cs','native-ui\WechatVoiceAdaptiveLayout.cs','native-ui\WechatVoiceUiaState.cs','native-ui\WechatVoiceUiaPointer.cs','native-audio\AudioRouteProbe.cs','native-audio\WavCablePlayback.cs','native-audio\TimedVoiceAudioPump.cs')) { $arguments += Join-Path $PSScriptRoot $source }
$arguments += Join-Path $PSScriptRoot 'tests\native\WechatDraftProbeSelfTest.cs'
$arguments += Join-Path $PSScriptRoot 'tests\native\WechatVoiceSelfTest.cs'
$arguments += Join-Path $PSScriptRoot 'native-audio\NativeVoiceAudio.cs'
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'VOICE_BUILD_FAILED' }
if ($SelfTest) { & $output --self-test; if ($LASTEXITCODE -ne 0) { throw 'VOICE_SELFTEST_FAILED' } }
Write-Output 'Voice preview built. No live recording, audio playback, or input was performed.'
