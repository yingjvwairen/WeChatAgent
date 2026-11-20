param([int]$Port = 3210, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$logDir = Join-Path $root 'state\logs'
try {
    if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Invalid console port.' }
    $url = 'http://127.0.0.1:' + $Port
    $connected = $false
    try {
        $info = Invoke-RestMethod ($url + '/api/info') -TimeoutSec 2
        if ($info.project -ne 'WeChatAgent Console' -or [IO.Path]::GetFullPath($info.root) -ne $root) { throw 'Console port is used by a different project.' }
        $connected = $true
    } catch {
        $client = [Net.Sockets.TcpClient]::new()
        $occupied = $false
        try {
            $task = $client.ConnectAsync('127.0.0.1', $Port)
            $occupied = $task.Wait(500) -and $client.Connected
        } catch {} finally { $client.Dispose() }
        if ($occupied) { throw 'Console port is occupied. Close the other console or choose another port.' }
    }
    if (-not $connected) {
        # Use this installation's saved DSH runtime, including on machines
        # without Node on PATH. Never take the coding app's cached runtime.
        $runtimeFile = Join-Path $root 'state\ui-runtime.json'
        if (Test-Path -LiteralPath $runtimeFile -PathType Leaf) {
            $runtime = Get-Content -LiteralPath $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($runtime.schemaVersion -ne 1 -or -not $runtime.node) { throw 'UI_RUNTIME_CONFIG_INVALID' }
            $node = [string]$runtime.node
        } else {
            $node = Get-Command node -CommandType Application -All -ErrorAction SilentlyContinue | Where-Object { $_.Source -notmatch '(^|[\\/])(\.codex|codex-runtimes|codex-primary-runtime)([\\/]|$)' } | Select-Object -First 1 -ExpandProperty Source
        }
        if (-not $node -or -not [IO.Path]::IsPathRooted($node) -or $node -match '(^|[\\/])(\.codex|codex-runtimes|codex-primary-runtime)([\\/]|$)' -or -not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Configure the DSH runtime or install an independent Node.js first.' }
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        $consoleEnvironment = @{}
        try {
            foreach ($entry in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'CODEX*' -or $_.Name -in @('NODE_OPTIONS','NODE_PATH','PYTHONHOME','PYTHONPATH','WECHATAGENT_CONSOLE_PORT','PATH') })) {
                $consoleEnvironment[$entry.Name] = $entry.Value
                Remove-Item -LiteralPath ('Env:' + $entry.Name)
            }
            $inheritedPaths = @(([string]$consoleEnvironment['PATH']).Split(';') | Where-Object { $_ -and $_ -notmatch '(^|[\\/])(\.codex|codex-runtimes|codex-primary-runtime)([\\/]|$)' })
            $env:PATH = (@((Split-Path -Parent $node)) + $inheritedPaths) -join ';'
            $env:WECHATAGENT_CONSOLE_PORT = [string]$Port
            $process = Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $PSScriptRoot 'console-server.mjs') + '"') -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'console.stdout.log') -RedirectStandardError (Join-Path $logDir 'console.stderr.log')
        } finally {
            foreach ($name in @('WECHATAGENT_CONSOLE_PORT','PATH')) { Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue }
            foreach ($name in $consoleEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name,$consoleEnvironment[$name],'Process') }
        }
        for ($i = 0; $i -lt 50; $i++) {
            if ($process.HasExited) { throw 'Console failed to start. See state/logs/console.stderr.log.' }
            try {
                $info = Invoke-RestMethod ($url + '/api/info') -TimeoutSec 1
                if ($info.project -ne 'WeChatAgent Console' -or [IO.Path]::GetFullPath($info.root) -ne $root) { throw 'Console identity mismatch.' }
                $connected = $true
                break
            } catch { Start-Sleep -Milliseconds 200 }
        }
        if (-not $connected) { throw 'Console did not respond. See state/logs/console.stderr.log.' }
    }
    if (-not $NoBrowser) { Start-Process -FilePath $url -WindowStyle Normal | Out-Null }
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'WeChatAgent Console', [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    exit 1
}
