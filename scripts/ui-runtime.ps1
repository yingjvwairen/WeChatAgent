param(
    [ValidateSet('configure','check','test','demo','visual','capture','voice-preview','dania-start','ui-bridge','reader-setup','reader-api','contact-identity','draft-probe')]
    [string]$Task = 'check',
    [string]$DshRoot,
    [switch]$InstallOcr,
    [string[]]$TaskArgs = @(),
    [string]$TaskArgsFile
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if ($TaskArgsFile) {
    if ($TaskArgs.Count -gt 0 -or -not [IO.Path]::IsPathRooted($TaskArgsFile)) { throw 'UI_RUNTIME_ARGUMENTS_INVALID' }
    $argumentsFile = Get-Item -LiteralPath $TaskArgsFile
    if ($argumentsFile.PSIsContainer -or $argumentsFile.Length -gt 65536) { throw 'UI_RUNTIME_ARGUMENTS_INVALID' }
    if ($Task -in @('configure','test','dania-start')) { throw 'UI_RUNTIME_ARGUMENTS_INVALID' }
    # Node reads the array itself: Windows PowerShell 5.1 also strips embedded
    # quote characters when forwarding native command arguments.
}
$runtimeFile = Join-Path $projectRoot 'state\ui-runtime.json'
if (-not $DshRoot) {
    if (-not (Test-Path -LiteralPath $runtimeFile -PathType Leaf)) { throw 'UI_RUNTIME_NOT_CONFIGURED: provide -DshRoot with the DSH installation directory.' }
    $saved = Get-Content -LiteralPath $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($saved.schemaVersion -ne 1 -or -not $saved.dshRoot) { throw 'UI_RUNTIME_CONFIG_INVALID' }
    $DshRoot = $saved.dshRoot
}
if (-not [IO.Path]::IsPathRooted($DshRoot)) { throw 'UI_RUNTIME_ABSOLUTE_DSH_ROOT_REQUIRED' }
$dshDirectory = [IO.Path]::GetFullPath($DshRoot)
$dependencyRoot = Join-Path $dshDirectory 'resources\runtime\primary-runtime\dependencies'
$nodeBinary = Join-Path $dependencyRoot 'node\bin\node.exe'
$pythonBinary = Join-Path $dependencyRoot 'python\python.exe'
foreach ($binary in @($nodeBinary,$pythonBinary)) {
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw ('UI_RUNTIME_MISSING: '+$binary) }
}
$originalPath = $env:PATH
$originalPythonPath = $env:PYTHONPATH
$originalPythonHome = $env:PYTHONHOME
$originalNodeOptions = $env:NODE_OPTIONS
$originalNodePath = $env:NODE_PATH
$removed = @{}
$temporaryArguments = $null
try {
    foreach ($item in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'CODEX*' })) {
        $removed[$item.Name]=$item.Value
        # PowerShell 7 on modern .NET can turn the null string argument into an
        # empty variable. Remove through the provider so Node sees no such key.
        Remove-Item -LiteralPath ('Env:' + $item.Name)
    }
    $env:PYTHONPATH=$null; $env:PYTHONHOME=$null
    $env:NODE_OPTIONS=$null; $env:NODE_PATH=$null
    $env:PATH=((Split-Path -Parent $nodeBinary),(Split-Path -Parent $pythonBinary),(Join-Path $env:WINDIR 'System32'),(Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0'),$env:WINDIR) -join ';'
$nodeVersion = & $nodeBinary --version
if ($LASTEXITCODE -ne 0 -or [version]($nodeVersion.TrimStart('v')) -lt [version]'22.13.0') { throw 'UI_RUNTIME_NODE_VERSION_UNSUPPORTED' }
$pythonVersion = & $pythonBinary -c 'import sys; print(str(sys.version_info.major)+chr(46)+str(sys.version_info.minor))'
if ($LASTEXITCODE -ne 0 -or $pythonVersion.Trim() -ne '3.12') { throw 'UI_RUNTIME_PYTHON_312_REQUIRED' }

if ($Task -eq 'configure') {
    $ocrDirectory = [IO.Path]::GetFullPath((Join-Path $projectRoot 'state\ocr\venv'))
    $stateDirectory = [IO.Path]::GetFullPath((Join-Path $projectRoot 'state'))
    if (-not $ocrDirectory.StartsWith($stateDirectory+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'UI_RUNTIME_PATH_INVALID' }
    $ocrPython = Join-Path $ocrDirectory 'Scripts\python.exe'
    if (Test-Path -LiteralPath $ocrPython -PathType Leaf) {
        $active = @(Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($ocrDirectory+'\',[StringComparison]::OrdinalIgnoreCase) })
        if ($active.Count -gt 0) { throw 'UI_RUNTIME_OCR_BUSY' }
        $venvConfig = Join-Path $ocrDirectory 'pyvenv.cfg'
        Copy-Item -LiteralPath $venvConfig -Destination ($venvConfig+'.before-'+[Guid]::NewGuid().ToString('N'))
        # Rebuild the launcher/base binding while retaining installed packages.
        & $pythonBinary -m venv --upgrade --without-pip $ocrDirectory
    } else {
        if (-not $InstallOcr) { throw 'UI_RUNTIME_OCR_MISSING: use -InstallOcr to prepare the optional OCR environment.' }
        & $pythonBinary -m venv $ocrDirectory
    }
    if ($LASTEXITCODE -ne 0) { throw 'UI_RUNTIME_VENV_PREPARE_FAILED' }
    if ($InstallOcr) {
        & $ocrPython -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot 'requirements-ocr.txt')
        if ($LASTEXITCODE -ne 0) { throw 'UI_RUNTIME_OCR_INSTALL_FAILED' }
    }
    & $ocrPython -c 'import sys,rapidocr,onnxruntime; assert sys.version_info[:2] == (3,12); print(sys.version)'
    if ($LASTEXITCODE -ne 0) { throw 'UI_RUNTIME_OCR_IMPORT_FAILED' }
    # Project-owned native development helper; compilation and synthetic tests
    # neither access the desktop nor start recording, playback or a live session.
    & (Join-Path $PSScriptRoot 'build-voice-probe.ps1') -SelfTest
    if ($LASTEXITCODE -ne 0) { throw 'UI_RUNTIME_VOICE_BUILD_FAILED' }
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    $data = [ordered]@{ schemaVersion=1; dshRoot=$dshDirectory; node=$nodeBinary; pythonBase=$pythonBinary; configuredAt=[DateTime]::UtcNow.ToString('o') }
    [IO.File]::WriteAllText($runtimeFile,($data | ConvertTo-Json)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
    Write-Output 'UI runtime configured using DSH. No global PATH or DSH plugin was modified.'
    exit 0
}

    # Resolve all runtimes explicitly; never borrow the calling shell's Node.
    if ($Task -eq 'test') {
        if ($TaskArgs.Count -gt 0) { throw 'UI_RUNTIME_ARGUMENTS_INVALID' }
        $testFiles = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'test-*.mjs' -File | Sort-Object Name | ForEach-Object { $_.FullName })
        & $nodeBinary --test @testFiles
        $taskExit = $LASTEXITCODE
    } else {
    $entry = switch ($Task) {
        'check' { 'ui-runtime-check.mjs' }
        'demo' { 'ui-preview.mjs' }
        'visual' { 'ui-preview.mjs' }
        'capture' { 'frame-probe.mjs' }
        'voice-preview' { 'voice-preview.mjs' }
        'dania-start' { 'dania-start.mjs' }
        'ui-bridge' { 'ui-onebot.mjs' }
        'reader-setup' { 'reader-local-setup.mjs' }
        'reader-api' { 'reader-local-api.mjs' }
        'contact-identity' { 'contact-identity.mjs' }
        'draft-probe' { 'draft-probe.mjs' }
    }
    $entryFile = Join-Path $PSScriptRoot $entry
    if (-not (Test-Path -LiteralPath $entryFile -PathType Leaf)) { throw 'UI_RUNTIME_ENTRY_NOT_BUILT' }
    $arguments = @()
    if ($Task -in @('demo','visual')) { $arguments += $Task }
    if ($Task -eq 'check') { $arguments += @('--config',$runtimeFile) }
    # These public tasks expose inspection only; live draft verification needs
    # a private, calibrated session and has no command-line entry point.
    if ($Task -in @('contact-identity','draft-probe')) { $arguments += '--inspect' }
    $arguments += $TaskArgs
    if (-not $TaskArgsFile -and $arguments.Count -gt 0) {
        $argumentsDirectory = Join-Path $projectRoot 'state'
        New-Item -ItemType Directory -Path $argumentsDirectory -Force | Out-Null
        $temporaryArguments = Join-Path $argumentsDirectory ('ui-args-'+[Guid]::NewGuid().ToString('D')+'.json')
        $argumentBytes = [Text.UTF8Encoding]::new($false).GetBytes((ConvertTo-Json -InputObject $arguments -Compress))
        $argumentStream = [IO.File]::Open($temporaryArguments,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $argumentStream.Write($argumentBytes,0,$argumentBytes.Length) } finally { $argumentStream.Dispose() }
        $TaskArgsFile = $temporaryArguments
        $arguments = @()
    }
    if ($TaskArgsFile) {
        $argumentsLoader = ([Uri](Join-Path $PSScriptRoot 'ui-runtime-args.mjs')).AbsoluteUri
        & $nodeBinary --import $argumentsLoader $entryFile @arguments --ui-runtime-args-file $TaskArgsFile
    } else {
        & $nodeBinary $entryFile @arguments
    }
    $taskExit = $LASTEXITCODE
    }
} finally {
    $env:PATH=$originalPath; $env:PYTHONPATH=$originalPythonPath; $env:PYTHONHOME=$originalPythonHome
    $env:NODE_OPTIONS=$originalNodeOptions; $env:NODE_PATH=$originalNodePath
    foreach ($name in $removed.Keys) { [Environment]::SetEnvironmentVariable($name,$removed[$name],'Process') }
    if ($temporaryArguments -and (Test-Path -LiteralPath $temporaryArguments -PathType Leaf)) {
        $resolvedArguments = [IO.Path]::GetFullPath($temporaryArguments)
        if ([IO.Path]::GetDirectoryName($resolvedArguments) -ne (Join-Path $projectRoot 'state') -or [IO.Path]::GetFileName($resolvedArguments) -notmatch '^ui-args-[a-f0-9-]{36}\.json$') { throw 'UI_RUNTIME_CLEANUP_PATH_INVALID' }
        Remove-Item -LiteralPath $resolvedArguments -Force
    }
}
exit $taskExit
