param()
$ErrorActionPreference = 'Stop'
$componentRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
function Assert-LocalComponentPath([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($componentRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'UI_COMPONENT_PATH_INVALID' }
    $cursor = $resolved
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'UI_COMPONENT_LINK_REFUSED' }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
}
$state = Join-Path $componentRoot 'state'
Assert-LocalComponentPath $state
foreach ($relative in @('ui-service.lock','reader-service\service.lock')) {
    if (Test-Path -LiteralPath (Join-Path $state $relative)) { throw 'UI_COMPONENT_STOP_SERVICES_FIRST' }
}
$runtime = Get-Content -LiteralPath (Join-Path $state 'ui-runtime.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($runtime.schemaVersion -ne 1 -or -not $runtime.pythonBase -or -not (Test-Path -LiteralPath $runtime.pythonBase -PathType Leaf)) { throw 'UI_RUNTIME_CONFIG_INVALID' }
if (-not $runtime.node -or -not (Test-Path -LiteralPath $runtime.node -PathType Leaf)) { throw 'UI_RUNTIME_CONFIG_INVALID' }
$navigationTemplates = Join-Path $PSScriptRoot 'wechat-navigation-templates.json'
Assert-LocalComponentPath $navigationTemplates
if (-not (Test-Path -LiteralPath $navigationTemplates -PathType Leaf) -or (Get-FileHash -LiteralPath $navigationTemplates -Algorithm SHA256).Hash -ne '7f10b2c4d70489b61d2fa1a94cc98f40e3181c77e3f3c4c4894987a83682c005') { throw 'UI_NAVIGATION_TEMPLATE_INVALID' }
$distributionFile = Join-Path $componentRoot 'config\distribution.json'
$installed = (Test-Path -LiteralPath $distributionFile -PathType Leaf) -and (Get-Content -LiteralPath $distributionFile -Raw -Encoding UTF8 | ConvertFrom-Json).installed -eq $true
if (-not $installed) {
    Write-Output '正在按锁文件准备 DSH 插件依赖。'
    & $runtime.node (Join-Path $PSScriptRoot 'prepare-ui-dependencies.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'UI_DEPENDENCY_INSTALL_FAILED: 请准备本机 npm，再重试。' }
}
foreach ($build in @('build-qt-actions.ps1','build-account-probe.ps1','build-voice-probe.ps1','build-audio-probe.ps1','build-visual-probe.ps1','build-frame-capture.ps1','build-draft-probe.ps1','build-ui-host.ps1','build-accessibility-gate.ps1','build-background-controls.ps1','build-uia-offscreen-host.ps1','build-offscreen-focus.ps1')) {
    & (Join-Path $PSScriptRoot $build)
    if ($LASTEXITCODE -ne 0) { throw 'UI_COMPONENT_BUILD_FAILED' }
}
$ocrDirectory = Join-Path $state 'ocr\venv'
Assert-LocalComponentPath $ocrDirectory
$ocrPython = Join-Path $ocrDirectory 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $ocrPython -PathType Leaf)) {
    & $runtime.pythonBase -I -m venv $ocrDirectory
    if ($LASTEXITCODE -ne 0) { throw 'UI_OCR_ENVIRONMENT_FAILED' }
}
& $ocrPython -I -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot 'requirements-ocr.txt')
if ($LASTEXITCODE -ne 0) { throw 'UI_OCR_DEPENDENCIES_FAILED' }
& $ocrPython -I -c 'import sys,rapidocr,onnxruntime; assert sys.version_info[:2] == (3,12); print(sys.version)'
if ($LASTEXITCODE -ne 0) { throw 'UI_OCR_ENVIRONMENT_FAILED' }
Write-Output '正在校验联系人识别模型；只在缺失或损坏时下载固定版本。'
& $runtime.node (Join-Path $PSScriptRoot 'prepare-local-ocr-model.mjs') --download
if ($LASTEXITCODE -ne 0) { throw 'UI_OCR_MODEL_PREPARE_FAILED' }
Write-Output '本机截图、输入、语音、文字识别与 UIA 控件组件已准备。尚未操作微信、启用无障碍标记、录音或发送消息；请继续本机界面标定。'
