param([string]$OutputFile, [string]$NodePath)
$ErrorActionPreference = 'Stop'
$exportRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
function Assert-NoExportLink([string]$ItemPath) {
    $ancestor = [IO.Path]::GetFullPath($ItemPath)
    while ($ancestor) {
        if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '源码或导出路径包含链接，请先检查后再导出。' }
        $parent = Split-Path -Parent $ancestor
        if ($parent -eq $ancestor) { break }
        $ancestor = $parent
    }
}
Assert-NoExportLink $exportRoot
# Only the reviewed first-party ZIP can be exported. Resolve its verifier from
# a saved DSH runtime or an independent Node; never require the coding app.
function Get-ExportNode {
    $candidate = $NodePath
    $runtimeFile = Join-Path $exportRoot 'state\ui-runtime.json'
    if (-not $candidate -and (Test-Path -LiteralPath $runtimeFile -PathType Leaf)) {
        Assert-NoExportLink $runtimeFile
        $runtime = Get-Content -LiteralPath $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($runtime.schemaVersion -eq 1) { $candidate = $runtime.node }
    }
    if (-not $candidate) {
        $candidate = @(Get-Command node -CommandType Application -All -ErrorAction SilentlyContinue | Where-Object { $_.Source -notmatch '(^|[\\/])(\.codex|codex-runtimes|codex-primary-runtime)([\\/]|$)' } | Select-Object -First 1 -ExpandProperty Source)
        if ($candidate.Count -gt 0) { $candidate = $candidate[0] } else { $candidate = $null }
    }
    if (-not $candidate) { throw '校验官方插件包需要 Node。请先配置 DSH 运行环境，或使用 -NodePath 指定独立 Node。' }
    if ($candidate -notmatch '^[A-Za-z]:[\\/]' -or $candidate -match '(^|[\\/])(\.codex|codex-runtimes|codex-primary-runtime)([\\/]|$)') { throw '请指定独立安装的 Node 或 DSH 内置 Node。' }
    $candidate = [IO.Path]::GetFullPath($candidate)
    if ($env:CODEX_HOME -and $candidate.StartsWith(([IO.Path]::GetFullPath($env:CODEX_HOME).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar),[StringComparison]::OrdinalIgnoreCase)) { throw '请指定独立安装的 Node 或 DSH 内置 Node。' }
    Assert-NoExportLink $candidate
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw '指定的 Node 不存在。' }
    return $candidate
}
function Test-SourcePlugin([byte[]]$Bytes) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = Get-ExportNode
    $start.Arguments = '"' + (Join-Path $PSScriptRoot 'verify-export-plugin.mjs') + '" "' + $exportRoot + '"'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($name in @($start.EnvironmentVariables.Keys)) {
        if ($name -like 'CODEX*' -or $name -in @('NODE_OPTIONS','NODE_PATH')) { $start.EnvironmentVariables.Remove($name) }
    }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw '无法校验官方插件包。' }
        $outputTask = $process.StandardOutput.ReadToEndAsync()
        $errorTask = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.BaseStream.Write($Bytes,0,$Bytes.Length)
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(30000)) { $process.Kill(); throw '官方插件包校验超时。' }
        $result = $outputTask.GetAwaiter().GetResult()
        $null = $errorTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw '官方插件包与公开源码不一致，已停止导出。请恢复或重新生成插件包。' }
        return ($result | ConvertFrom-Json)
    } finally { $process.Dispose() }
}
if (-not $OutputFile) { $OutputFile = Join-Path $exportRoot ('state\deployment-export\WeChatAgent-source-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss') + '.zip') }
$outputArchive = [IO.Path]::GetFullPath($OutputFile)
if ($outputArchive -notmatch '^[A-Za-z]:[\\/]') { throw '请将源码包保存到本机完整路径。' }
Assert-NoExportLink $outputArchive
if (Test-Path -LiteralPath $outputArchive) { throw '目标压缩包已存在，请换一个文件名。' }
# Respect the repository exclusions; include this checkout's uncommitted source.
# Do not copy the working directory recursively: state contains DPAPI credentials,
# chat data, transient authorizations, and machine-specific calibration handles.
# Read UTF-8/NUL directly. Windows PowerShell's native text pipeline can corrupt
# Chinese persona filenames, and line-based Git output quotes unusual names.
$sourceGit = (Get-Command git -CommandType Application -ErrorAction Stop).Source
function Read-SourceGit([string]$Arguments, [string]$InputText = '', [int[]]$AllowedExitCodes = @(0)) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $sourceGit
    $start.Arguments = '-C "' + $exportRoot + '" ' + $Arguments
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw '无法读取 Git 源码清单。' }
        $outputTask = $process.StandardOutput.ReadToEndAsync()
        $errorTask = $process.StandardError.ReadToEndAsync()
        $inputBytes = [Text.UTF8Encoding]::new($false).GetBytes($InputText)
        if ($inputBytes.Length -gt 0) { $process.StandardInput.BaseStream.Write($inputBytes,0,$inputBytes.Length) }
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(30000)) { $process.Kill(); throw '读取 Git 源码清单超时。' }
        $result = $outputTask.GetAwaiter().GetResult()
        $null = $errorTask.GetAwaiter().GetResult()
        if ($process.ExitCode -notin $AllowedExitCodes) { throw '无法读取项目源码清单。请在 Git 项目中运行。' }
        return $result
    } finally { $process.Dispose() }
}
$sourceNames = @((Read-SourceGit 'ls-files -z --cached --others --exclude-standard').Split([char]0) | Where-Object { $_ })
if ($sourceNames.Count -eq 0) { throw '没有可导出的源码文件。' }
# --cached includes files that became ignored after they were committed. Apply
# current ignore rules to those files too, including component-local rules.
$ignoredNames = (Read-SourceGit 'check-ignore --no-index -z --stdin' (($sourceNames -join [char]0) + [char]0) @(0,1)).Split([char]0)
$ignored = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($relative in $ignoredNames) { if ($relative) { $null = $ignored.Add($relative) } }
$exportFiles = [Collections.Generic.List[object]]::new()
foreach ($relative in ($sourceNames | Sort-Object -Unique)) {
    if (-not $relative -or $ignored.Contains($relative) -or $relative -match '(^|/)(state|release|audit-local|\.git|\.local-state|node_modules|\.venv|venv|__pycache__)/' -or $relative -match '(^|/)\.env($|\.)') { continue }
    if ($relative -match '^config/' -and $relative -notmatch '^config/[^/]+\.example\.json$') { continue }
    $isSourcePlugin = $relative -ceq 'optional-extensions/packages/fish-notebook-1.0.0.zip'
    if (-not $isSourcePlugin -and $relative -match '(^|/)privacy-rules\.json$|\.(exe|dll|node|pdb|obj|lib|so|dylib|pyc|pyo|pfx|pem|key|log|pid|tmp|bak|db(?:-wal|-shm)?|sqlite|sqlite3|zip|7z|rar|tgz|ckpt|pth)$') { continue }
    if ($relative -match '[\x00-\x1f]' -or [IO.Path]::IsPathRooted($relative)) { throw '源码清单包含不支持的路径。' }
    $absolute = [IO.Path]::GetFullPath((Join-Path $exportRoot $relative))
    if (-not $absolute.StartsWith($exportRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw '源码清单包含项目外路径。' }
    if (-not (Test-Path -LiteralPath $absolute -PathType Leaf)) { continue }
    Assert-NoExportLink $absolute
    if ($absolute -eq $outputArchive) { continue }
    $exportFiles.Add(@{ Path=$absolute; Entry=$relative.Replace('\','/') })
}
if ($exportFiles.Count -lt 1) { throw '没有可导出的源码文件。' }
foreach ($file in $exportFiles) {
    if ($file.Entry -cne 'optional-extensions/packages/fish-notebook-1.0.0.zip') { continue }
    if ((Get-Item -LiteralPath $file.Path).Length -gt 8MB) { throw '官方插件包超过允许大小，已停止导出。' }
    $bytes = [IO.File]::ReadAllBytes($file.Path)
    $report = Test-SourcePlugin $bytes
    if ($report.archive -cne $file.Entry -or @($report.sourceFiles).Count -ne 4) { throw '官方插件包校验结果无效。' }
    foreach ($source in $report.sourceFiles) {
        if (-not ($exportFiles | Where-Object { $_.Entry -ceq $source })) { throw '官方插件包对应源码未包含在公开源码清单，已停止导出。' }
    }
    $file.Bytes = $bytes
}
New-Item -ItemType Directory -Path (Split-Path -Parent $outputArchive) -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$outputStream = [IO.File]::Open($outputArchive,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
$archive = $null
try {
    $archive = [IO.Compression.ZipArchive]::new($outputStream,[IO.Compression.ZipArchiveMode]::Create,$false)
    foreach ($file in $exportFiles) {
        if ($file.ContainsKey('Bytes')) {
            $entry = $archive.CreateEntry($file.Entry,[IO.Compression.CompressionLevel]::Optimal)
            $entryStream = $entry.Open()
            try { $entryStream.Write($file.Bytes,0,$file.Bytes.Length) } finally { $entryStream.Dispose() }
        } else { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$file.Path,$file.Entry,[IO.Compression.CompressionLevel]::Optimal) | Out-Null }
    }
} finally { if ($archive) { $archive.Dispose() }; $outputStream.Dispose() }
Write-Output ('源码包已生成：' + $outputArchive)
Write-Output '已排除忽略项、已知本机状态/凭据路径、依赖环境和模型；未扫描任意源码正文是否含个人信息。副机需重新建立本机配置。'
