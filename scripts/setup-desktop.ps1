param([string]$PythonPath = '', [switch]$SkipModelDownload)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$configFile = Join-Path $root 'config\wechatagent.json'
$settings = if (Test-Path -LiteralPath $configFile) { Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
$distributionFile = Join-Path $root 'config\distribution.json'
$distribution = if (Test-Path -LiteralPath $distributionFile) { Get-Content -LiteralPath $distributionFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
function Resolve-SetupProgram([string]$Value) {
    if (-not $Value) { throw 'DESKTOP_PYTHON_REQUIRED' }
    if ([IO.Path]::IsPathRooted($Value)) {
        if (-not (Test-Path -LiteralPath $Value -PathType Leaf)) { throw 'DESKTOP_PYTHON_UNAVAILABLE' }
        return [IO.Path]::GetFullPath($Value)
    }
    if ($Value.Contains('\') -or $Value.Contains('/')) {
        $candidate = Join-Path $root $Value
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw 'DESKTOP_PYTHON_UNAVAILABLE' }
        return [IO.Path]::GetFullPath($candidate)
    }
    return (Get-Command $Value -ErrorAction Stop).Source
}
if ($distribution.installed -eq $true) {
    if ($distribution.desktopRuntime -ne $true) { throw 'DESKTOP_DISTRIBUTION_INVALID' }
    $selectedPython = [string]$settings.input.python
    if (-not $selectedPython) { $selectedPython = [string]$distribution.desktopPython }
    if (-not $selectedPython) { $selectedPython = [string]$distribution.python }
    $python = Resolve-SetupProgram $selectedPython
    $ocrPython = Resolve-SetupProgram ([string]$distribution.ocrPython)
    & $python -I -B -c 'import psutil,win32api,win32clipboard,win32gui,win32process,PIL; print(''DESKTOP_PYTHON_OK'')'
    if ($LASTEXITCODE -ne 0) { throw 'DESKTOP_RUNTIME_IMPORT_FAILED' }
    $ocrCheck = @'
import importlib.util, pathlib, sys
root = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('local_ocr_check', root / 'scripts/desktop-sender/local-ocr.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.check_runtime()
sys.addaudithook(module.deny_network)
import rapidocr
bundled = pathlib.Path(rapidocr.__file__).parent / 'models'
for name in module.MODEL_HASHES:
    model = root / 'state/ocr/models' / name if 'medium' in name else bundled / name
    module.checked_model(model)
print('DESKTOP_OCR_OK models=4')
'@
    & $ocrPython -I -B -c $ocrCheck $root
    if ($LASTEXITCODE -ne 0) { throw 'DESKTOP_OCR_RUNTIME_FAILED' }
    foreach ($name in @('WechatQtActions','WechatVoicePreview','WechatBackgroundControls','WechatAccountProbe','WechatVisualProbe','WechatQuoteHistory','WechatUiaOffscreenHost','WechatOffscreenFocus','AudioRouteProbe','WechatAccessibilityGate42053')) {
        if (-not (Test-Path -LiteralPath (Join-Path $root ('state\ui-host\' + $name + '.exe')) -PathType Leaf)) { throw ('DESKTOP_COMPONENT_MISSING: ' + $name) }
    }
    Write-Output 'Installed desktop runtime imports, model hashes and component files verified. No packages installed or native components rebuilt.'
    exit 0
}
# Source checkouts prepare their isolated default input environment. An explicit
# input.python remains selected; the supplied Python bootstraps the default venvs.
if (-not $PythonPath) { $PythonPath = [string]$settings.runtime.python }
if (-not $PythonPath) { $PythonPath = 'python' }
$basePython = Resolve-SetupProgram $PythonPath
$selectedPython = [string]$settings.input.python
if ($selectedPython) { $python = Resolve-SetupProgram $selectedPython }
else {
    $inputDirectory = Join-Path $root 'state\input\venv'
    $python = Join-Path $inputDirectory 'Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
        & $basePython -m venv $inputDirectory
        if ($LASTEXITCODE -ne 0) { throw 'DESKTOP_ENVIRONMENT_CREATE_FAILED' }
    }
}
& $python -m pip install --only-binary=:all: -r (Join-Path $PSScriptRoot 'desktop-requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'DESKTOP_DEPENDENCY_INSTALL_FAILED' }
$ocrDirectory = Join-Path $root 'state\ocr\venv'
$ocrPython = Join-Path $ocrDirectory 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $ocrPython -PathType Leaf)) {
    & $basePython -m venv $ocrDirectory
    if ($LASTEXITCODE -ne 0) { throw 'OCR_ENVIRONMENT_CREATE_FAILED' }
}
& $ocrPython -m pip install --only-binary=:all: -r (Join-Path $PSScriptRoot 'desktop-sender\requirements-ocr.txt')
if ($LASTEXITCODE -ne 0) { throw 'OCR_DEPENDENCY_INSTALL_FAILED' }
& $ocrPython -m pip check
if ($LASTEXITCODE -ne 0) { throw 'OCR_DEPENDENCY_CONFLICT' }
& (Join-Path $PSScriptRoot 'desktop-sender\build-native.ps1') -SelfTest
& (Join-Path $PSScriptRoot 'build-accessibility-gate-42053.ps1') -SelfTest
if (-not $SkipModelDownload) {
    & node (Join-Path $PSScriptRoot 'desktop-sender\prepare-local-ocr-model.mjs') --download
    if ($LASTEXITCODE -ne 0) { throw 'OCR_MODEL_PREPARATION_FAILED' }
}
Write-Output 'Desktop OCR/UIA components are ready. Select your supported WeChat installation in the console.'
