param(
    [ValidateSet('configure','console','voice-server','start','stop','restart','status','prepare','reader-connect','reader-activate','prepare-components')][string]$Task = 'console',
    [string]$DshRoot,
    [string]$SettingsFile
)
$ErrorActionPreference = 'Stop'
$secondaryRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$runtimePath = Join-Path $secondaryRoot 'state\ui-runtime.json'
if ($Task -eq 'configure') {
    if (-not $DshRoot -or -not $SettingsFile) { throw '请提供副机的 DSH 目录和配置文件。' }
} else {
    $savedRuntime = Get-Content -LiteralPath $runtimePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($savedRuntime.schemaVersion -ne 1 -or -not $savedRuntime.dshRoot -or -not (Test-Path -LiteralPath (Join-Path $secondaryRoot 'state\secondary-deployment.json') -PathType Leaf)) { throw '请先在这个副机项目目录完成路径配置。' }
    if ($DshRoot -and [IO.Path]::GetFullPath($DshRoot).TrimEnd([char[]]'\/') -ne [IO.Path]::GetFullPath($savedRuntime.dshRoot).TrimEnd([char[]]'\/')) { throw '指定的 DSH 目录与本机配置不一致。' }
    $DshRoot = [string]$savedRuntime.dshRoot
}
if ($DshRoot -notmatch '^[A-Za-z]:[\\/]' -or $DshRoot -match '[\x00\r\n]') { throw 'DSH 目录必须是本机完整路径。' }
$DshRoot = [IO.Path]::GetFullPath($DshRoot)
if ($DshRoot -match '(^|[\\/])(\.codex|codex-runtimes|codex-primary-runtime)([\\/]|$)') { throw '请使用副机独立安装的 DSH，不能使用开发工具缓存。' }
$secondaryNode = Join-Path $DshRoot 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $secondaryNode -PathType Leaf)) { throw '未找到副机 DSH 自带的运行程序。' }
$savedEnvironment = @{}
$environmentNames = @('PATH','PSModulePath','DSH_HOME','WECHATAGENT_CONSOLE_PORT','NODE_OPTIONS','NODE_PATH','PYTHONHOME','PYTHONPATH')
$secondaryExit = 1
try {
    foreach ($entry in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'CODEX*' -or $_.Name -in $environmentNames })) {
        $savedEnvironment[$entry.Name] = $entry.Value
        Remove-Item -LiteralPath ('Env:' + $entry.Name)
    }
    # Keep installed CUDA/FFmpeg and other user tools, but never use development
    # runtime caches. These are process-local changes, restored in finally.
    $inheritedPath = @(([string]$savedEnvironment['PATH']).Split(';') | Where-Object { $_ -and $_ -notmatch '(^|[\\/])(\.codex|codex-runtimes|codex-primary-runtime)([\\/]|$)' })
    $env:PATH = (@((Split-Path -Parent $secondaryNode),(Join-Path $DshRoot 'resources\runtime\primary-runtime\dependencies\python'),(Join-Path $env:WINDIR 'System32'),(Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0'),$env:WINDIR) + $inheritedPath) -join ';'
    $env:PSModulePath = @((Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\Modules'),(Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules')) -join ';'
    if ($Task -eq 'configure') {
        & $secondaryNode (Join-Path $PSScriptRoot 'secondary-setup.mjs') --settings ([IO.Path]::GetFullPath($SettingsFile))
    } elseif ($Task -eq 'voice-server') {
        & $secondaryNode (Join-Path $PSScriptRoot 'dania-start.mjs')
    } elseif ($Task -eq 'prepare-components') {
        & (Join-Path $PSScriptRoot 'prepare-ui-components.ps1')
    } elseif ($Task -in @('start','stop','restart','status','prepare')) {
        & (Join-Path $PSScriptRoot 'manage.ps1') $Task
    } elseif ($Task -in @('reader-connect','reader-activate')) {
        $readerAction = if ($Task -eq 'reader-connect') { '--connect-and-activate' } else { '--activate' }
        & $secondaryNode (Join-Path $PSScriptRoot 'reader-local-setup.mjs') $readerAction
    } else {
        # This is the console process itself, not an automatic sender/manager.
        Write-Output '副机控制台：http://127.0.0.1:3210/#overview（不会自动发送消息）'
        & $secondaryNode (Join-Path $PSScriptRoot 'console-server.mjs')
    }
    $secondaryExit = $LASTEXITCODE
} finally {
    foreach ($name in $environmentNames) { Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue }
    foreach ($entry in $savedEnvironment.GetEnumerator()) { Set-Item -LiteralPath ('Env:' + $entry.Key) -Value $entry.Value }
}
exit $secondaryExit
