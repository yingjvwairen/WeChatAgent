param([switch]$SelfTest, [string]$OutputDirectory, [switch]$ClipboardFixture)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'QT_COMPILER_UNAVAILABLE' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'state\ui-host' }
if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'QT_OUTPUT_DIRECTORY_INVALID' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$entry = if ($ClipboardFixture) { 'WechatClipboardFixture' } else { 'WechatQtActions' }
$output = Join-Path $OutputDirectory ($entry + '.exe')
$arguments = @('/nologo','/target:exe','/platform:x64','/optimize+','/warn:4',('/main:' + $entry),('/out:' + $output))
foreach ($reference in @('System.Web.Extensions.dll','System.Windows.Forms.dll','System.Drawing.dll','System.Xml.dll','WPF\WindowsBase.dll','WPF\UIAutomationClient.dll','WPF\UIAutomationTypes.dll')) { $arguments += '/reference:' + (Join-Path $framework $reference) }
foreach ($source in @('native-ui\WechatDraftProbe.cs','native-ui\WechatWindowBinding.cs','native-ui\WechatClipboardSnapshot.cs','native-ui\WechatClipboardFormats.cs','native-ui\WechatFocusSafety.cs','native-ui\WechatUiaCaptionGeometry.cs','native-ui\WechatOffscreenActivationClient.cs','native-ui\WechatWindowMessageInput.cs','native-ui\WechatQtActions.cs','native-ui\WechatQtReturnCaption.cs','native-ui\WechatQtLayoutCapture.cs','native-ui\WechatQtImagePaste.cs','native-ui\WechatQtUiaGeometry.cs','native-ui\WechatQtUiaControls.cs','native-ui\WechatQtQuote.cs','native-ui\WechatQtQuoteOcr.cs','native-ui\WechatQtUiaPointer.cs')) { $arguments += Join-Path $PSScriptRoot $source }
foreach ($unit in @('WechatQtPopupNavigation','WechatQtDraftInspection','WechatQtForegroundSession','WechatQtFocusHandoff','WechatQtClipboard','WechatQtTextSubmission','WechatQtTextPaste','WechatQtActionsSelfTest')) {
    $arguments += Join-Path $PSScriptRoot ('native-ui\' + $unit + '.cs')
}
if ($ClipboardFixture) { $arguments += Join-Path $PSScriptRoot 'tests\native\WechatClipboardFixture.cs' }
$arguments += Join-Path $PSScriptRoot 'tests\native\WechatDraftProbeSelfTest.cs'
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'QT_BUILD_FAILED' }
if ($SelfTest) { & $output --self-test; if ($LASTEXITCODE -ne 0) { throw 'QT_SELFTEST_FAILED' } }
if ($SelfTest -and -not $ClipboardFixture) {
    & $output --draft-probe --self-test
    if ($LASTEXITCODE -ne 0) { throw 'DRAFT_SELFTEST_FAILED' }
    $testDirectory = Join-Path ([IO.Path]::GetTempPath()) ('wechat-clipboard-test-' + [guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $testDirectory -ErrorAction Stop | Out-Null
    try {
        & $PSCommandPath -OutputDirectory $testDirectory -ClipboardFixture -SelfTest
    } finally {
        $fixture = Join-Path $testDirectory 'WechatClipboardFixture.exe'
        if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Force }
        [IO.Directory]::Delete($testDirectory)
    }
}
Write-Output 'Qt actions built. No application was accessed and no input was sent.'
