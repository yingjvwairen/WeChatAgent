param([ValidateSet('start','stop','restart','status','prepare')][string]$Action = 'start')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root 'state'
$recordFile = Join-Path $stateDir 'runtime.json'
$script:record = @{}
if (Test-Path -LiteralPath $recordFile) {
    $saved = Get-Content -LiteralPath $recordFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($property in $saved.PSObject.Properties) { $script:record[$property.Name] = $property.Value }
}
function Save-Record { $script:record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $recordFile -Encoding UTF8 }
function Test-Port([int]$Port) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try { $task = $client.ConnectAsync('127.0.0.1',$Port); return ($task.Wait(700) -and $client.Connected) }
    catch { return $false } finally { $client.Dispose() }
}
function Owned-Process($Item,[switch]$AllowStale) {
    if (-not $Item) { return $null }
    $markerRoot = [IO.Path]::GetFullPath($root).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    if (-not $Item.marker -or -not [IO.Path]::IsPathRooted([string]$Item.marker)) { throw 'Cannot verify recorded process marker; refusing to stop it.' }
    $markerInRoot = [IO.Path]::GetFullPath([string]$Item.marker).StartsWith($markerRoot,[StringComparison]::OrdinalIgnoreCase)
    if (-not $markerInRoot) {
        if ($AllowStale) { Write-Host 'Discarded a foreign installation process record; unrelated process was not stopped.'; return $null }
        throw 'Recorded process belongs to another installation; refusing to stop or reuse it.'
    }
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $Item.pid)
    if (-not $process) { return $null }
    if (-not $process.ExecutablePath -or -not $process.CommandLine) { throw 'Cannot verify recorded process identity; refusing to stop it.' }
    if ($process.ExecutablePath -ne $Item.exe -or $process.CommandLine.IndexOf($Item.marker,[StringComparison]::OrdinalIgnoreCase) -lt 0) {
        if ($AllowStale) { Write-Host 'Discarded a stale service process record; unrelated process was not stopped.'; return $null }
        throw 'Recorded PID no longer belongs to WeChatAgent; refusing to stop it.'
    }
    return $process
}
function Stop-Services {
    $stopErrors = [System.Collections.Generic.List[string]]::new()
    $externalWeFlow = $false
    $settingsFile = Join-Path $root 'config\wechatagent.json'
    if (Test-Path -LiteralPath $settingsFile) {
        $settings = Get-Content $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $externalWeFlow = $settings.runtime.weflowMode -eq 'existing'
    }
    foreach ($name in @('adapter','bridge','reader','weflow')) {
        if ($name -eq 'weflow' -and $externalWeFlow) { continue }
        if ($script:record.ContainsKey($name)) {
          try {
            $item = $script:record[$name]
            if (Owned-Process $item -AllowStale) {
                $stoppedGracefully = $false
                if ($name -eq 'adapter' -and $settings.runtime.sender -eq 'wechat-ui') {
                    # The supervisor owns a Reader child and possibly an active
                    # recording. Never terminate it before cleanup acknowledges.
                    $serviceToken = (Get-Content -LiteralPath (Join-Path $stateDir 'social-dsh-token.txt') -Raw).Trim()
                    $null = Invoke-RestMethod ('http://127.0.0.1:'+$settings.ports.adapter+'/shutdown') -Method Post -Headers @{Authorization='Bearer '+$serviceToken} -TimeoutSec 3
                    try { Wait-Process -Id $item.pid -Timeout 30 -ErrorAction Stop }
                    catch { if (Owned-Process $item -AllowStale) { throw } }
                    if (Test-Path -LiteralPath (Join-Path $stateDir 'ui-service.lock')) { throw 'UI_SERVICE_CLEANUP_UNCONFIRMED: ownership record retained.' }
                    $stoppedGracefully = $true
                }
                if ($name -eq 'weflow') {
                    try {
                        $api = Get-Content (Join-Path $stateDir 'wechat-io-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
                        $null = Invoke-RestMethod ($api.reader_base_url + '/api/v1/wechatagent/shutdown') -Method Post -Headers @{Authorization='Bearer '+$api.reader_token} -TimeoutSec 3
                        Wait-Process -Id $item.pid -Timeout 10 -ErrorAction Stop
                        $stoppedGracefully = $true
                    } catch {}
                }
                if (-not $stoppedGracefully) {
                    try { Stop-Process -Id $item.pid -ErrorAction Stop }
                    catch { if (Owned-Process $item -AllowStale) { throw } }
                    try { Wait-Process -Id $item.pid -Timeout 10 -ErrorAction Stop }
                    catch { if (Owned-Process $item -AllowStale) { throw 'Managed process did not stop before the deadline.' } }
                }
            }
            $script:record.Remove($name); Save-Record
            Write-Output ($name + ' stopped.')
          } catch {
            $stopErrors.Add($name)
            Write-Output ($name + ' could not be stopped; its ownership record was retained.')
          }
        }
    }
    if ($stopErrors.Count) { throw ('Managed services could not be stopped: ' + ($stopErrors -join ', ') + '. See state/logs/shutdown.log.') }
}
function Get-PortBindings([int]$Port) {
    try { $connections=@(Get-NetTCPConnection -LocalPort $Port -ErrorAction Stop) }
    catch {
        if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { return @() }
        throw ('SERVICE_PORT_INSPECTION_FAILED port='+$Port)
    }
    # These services bind IPv4 loopback. A separate IPv6-only listener may
    # legitimately share the number; the IPv4 bind probe remains final.
    return @($connections | Where-Object { [string]$_.State -in @('Listen','Bound') -and $_.LocalAddress -in @('127.0.0.1','0.0.0.0') })
}
function Assert-PortBindable([string]$Name,[int]$Port) {
    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$Port)
    try { $listener.Server.ExclusiveAddressUse=$true; $listener.Start() }
    catch {
        $failure=$_.Exception;$nativeCode='UNKNOWN'
        while($failure){if($failure -is [Net.Sockets.SocketException]){$nativeCode=[string]$failure.NativeErrorCode;break};$failure=$failure.InnerException}
        $reason=if($nativeCode -eq '10048'){'SERVICE_PORT_IN_USE'}elseif($nativeCode -eq '10013'){'SERVICE_PORT_DENIED'}else{'SERVICE_PORT_UNAVAILABLE'}
        throw ($reason+' service='+$Name+' port='+$Port+' system='+$nativeCode)
    } finally { $listener.Stop() }
}
function Test-ServiceReady([string]$Name,[int]$Port,[int]$ExpectedProcessId,[string]$ExpectedBackend = 'wechat-ui') {
    $listeners=@(Get-PortBindings $Port | Where-Object { [string]$_.State -eq 'Listen' })
    if(-not $listeners.Count){return $false}
    $owners=@($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    if(@($owners | Where-Object {[int]$_ -ne $ExpectedProcessId}).Count){throw ('SERVICE_PORT_OWNER_MISMATCH service='+$Name+' port='+$Port+' expectedPid='+$ExpectedProcessId+' owners='+($owners -join ','))}
    if($Name -eq 'adapter'){
        try{$health=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$Port+'/status') -TimeoutSec 1}catch{return $false}
        $healthPid=0
        if(-not [int]::TryParse([string]$health.pid,[ref]$healthPid) -or $health.project -ne 'WeChatAgent' -or $health.component -ne 'adapter' -or $health.statusVersion -ne 1 -or $health.backend -ne $ExpectedBackend -or $healthPid -ne $ExpectedProcessId -or $health.projectRoot -isnot [string]){throw ('ADAPTER_IDENTITY_MISMATCH port='+$Port+' expectedPid='+$ExpectedProcessId)}
        $sameRoot=$false;try{$sameRoot=[IO.Path]::GetFullPath($health.projectRoot).TrimEnd('\','/') -eq [IO.Path]::GetFullPath($root).TrimEnd('\','/')}catch{}
        if(-not $sameRoot){throw ('ADAPTER_IDENTITY_MISMATCH port='+$Port+' expectedPid='+$ExpectedProcessId)}
        return $health.ready -eq $true
    }
    return $true
}
function Start-ServiceProcess([string]$Name,[string]$Exe,[string]$Arguments,[string]$Directory,[string]$Marker,[int]$Port,[bool]$Visible) {
    $bindings=@(Get-PortBindings $Port)
    if($bindings.Count){
        $item=$script:record[$Name];$existing=$null
        try{$existing=Owned-Process $item}catch{}
        $owners=@($bindings | Select-Object -ExpandProperty OwningProcess -Unique)
        if(-not $existing -or @($owners | Where-Object {[int]$_ -ne [int]$item.pid}).Count){throw ('SERVICE_PORT_IN_USE service='+$Name+' port='+$Port+' owners='+($owners -join ','))}
        $process=Get-Process -Id ([int]$item.pid) -ErrorAction Stop
    }else{
        # A failed connection does not prove the port can be bound. This
        # preflight is advisory; the child listener and identity remain final.
        Assert-PortBindable $Name $Port
        $style = if ($Visible) { 'Normal' } else { 'Hidden' }
        $process = Start-Process -FilePath $Exe -ArgumentList $Arguments -WorkingDirectory $Directory -WindowStyle $style -PassThru -RedirectStandardOutput (Join-Path $stateDir ('logs\'+$Name+'.stdout.log')) -RedirectStandardError (Join-Path $stateDir ('logs\'+$Name+'.stderr.log'))
        $script:record[$Name] = @{pid=$process.Id;exe=$Exe;marker=$Marker}; Save-Record
    }
    $watch=[Diagnostics.Stopwatch]::StartNew()
    do {
        $process.Refresh()
        if ($process.HasExited) {
            $failureLog = Join-Path $stateDir ('logs\'+$Name+'.stderr.log')
            if (Test-Path -LiteralPath $failureLog) {
                Get-Content -LiteralPath $failureLog -Encoding UTF8 -Tail 30 | ForEach-Object { Write-Output $_ }
            }
            throw ($Name + ' exited; see state/logs/'+$Name+'.stderr.log')
        }
        if(Test-ServiceReady $Name $Port ([int]$process.Id) 'wechat-ui'){return}
        Start-Sleep -Milliseconds 250
    }while($watch.Elapsed.TotalSeconds -lt 45)
    throw ('SERVICE_START_TIMEOUT service='+$Name+' port='+$Port+'. Finish its setup or restart this instance before retrying.')
}
function Show-Status($Config) {
    Write-Output ('Sender: '+$Config.runtime.sender)
    foreach ($property in $Config.ports.PSObject.Properties) { Write-Output ($property.Name + ': ' + (Test-Port ([int]$property.Value))) }
    $wechatRunning = [bool](Get-Process Weixin,WeChat -ErrorAction SilentlyContinue)
    Write-Output ('WeChat desktop running: ' + $wechatRunning)
    if (-not $wechatRunning) { Write-Output 'Open desktop WeChat and log in to receive new messages.' }
    $databaseReady = $false
    try { $databaseReady = (Invoke-RestMethod ('http://127.0.0.1:'+$Config.ports.adapter+'/status') -TimeoutSec 3).reader_connected -eq $true } catch {}
    Write-Output ('Database ready: ' + $databaseReady)
    if (Test-Port ([int]$Config.ports.adapter)) {
        $status = Invoke-RestMethod ('http://127.0.0.1:'+$Config.ports.adapter+'/status') -TimeoutSec 3
        Write-Output ('OneBot connected: '+$status.ob_connected); Write-Output ('Reader connected: '+$status.reader_connected)
    }
    Write-Output ('Logs: '+(Join-Path $stateDir 'logs'))
}
if ($Action -eq 'stop') { Stop-Services; exit 0 }
$uiRuntimeFile = Join-Path $stateDir 'ui-runtime.json'
if (Test-Path -LiteralPath $uiRuntimeFile -PathType Leaf) {
    $uiRuntime = Get-Content -LiteralPath $uiRuntimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($uiRuntime.schemaVersion -ne 1 -or -not $uiRuntime.node -or -not (Test-Path -LiteralPath $uiRuntime.node -PathType Leaf)) { throw 'UI_RUNTIME_CONFIG_INVALID' }
    $node = [IO.Path]::GetFullPath([string]$uiRuntime.node)
} else { $node = (Get-Command node -ErrorAction Stop).Source }
& $node (Join-Path $PSScriptRoot 'project-config.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Invalid project configuration.' }
$config = Get-Content (Join-Path $root 'config\wechatagent.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Action -eq 'prepare') { exit 0 }
if ($Action -eq 'status') { Show-Status $config; exit 0 }
if ($Action -eq 'restart') { Stop-Services }
& $node (Join-Path $PSScriptRoot 'ui-service.mjs') --check
if ($LASTEXITCODE -ne 0) { throw 'UI_SERVICE_CONFIG_REQUIRED: Configure the local Reader and desktop binding before starting.' }
$names = @('SOCIAL_DSH_TOKEN','PYTHONUTF8','PYTHONUNBUFFERED','WECHATAGENT_LOG_DIR','WECHATAGENT_STATE_DIR')
$previous = @{}; foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
try {
    Write-Output 'Using selected-contact Reader managed by the UI service.'
    $env:SOCIAL_DSH_TOKEN = (Get-Content (Join-Path $stateDir 'social-dsh-token.txt') -Raw).Trim()
    $dshUrl = 'http://127.0.0.1:'+$config.ports.dshPlugin+'/health'
    if (-not (Test-Port ([int]$config.ports.dshPlugin))) {
        if (-not $config.runtime.dshDesktop -or -not (Test-Path -LiteralPath $config.runtime.dshDesktop)) { throw 'DSH_NOT_CONFIGURED: Install DSH from the setup link, then select its executable and save settings.' }
        & (Join-Path $PSScriptRoot 'launch-dsh.ps1')
        for($i=0;$i -lt 60 -and -not (Test-Port ([int]$config.ports.dshPlugin));$i++){Start-Sleep -Milliseconds 250}
        if (-not (Test-Port ([int]$config.ports.dshPlugin))) { throw 'DSH_PLUGIN_NOT_READY: Enable the local plugin in DSH and fully reopen DSH from the tray.' }
    }
    $health = Invoke-RestMethod $dshUrl -Headers @{Authorization='Bearer '+$env:SOCIAL_DSH_TOKEN} -TimeoutSec 3
    $accountIdentityFile = Join-Path $stateDir 'weflow\active-account.json'
    if (Test-Path -LiteralPath $accountIdentityFile) {
        $accountIdentity = Get-Content -LiteralPath $accountIdentityFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($health.accountScope -ne $accountIdentity.id) { throw 'ACCOUNT_SWITCH_REQUIRES_DSH_RESTART: Fully exit DSH from the tray and reopen it after switching account.' }
    }
    if ($health.ok -ne $true -or $health.project -ne 'WeChatAgent' -or [IO.Path]::GetFullPath($health.projectRoot) -ne [IO.Path]::GetFullPath($root)) { throw 'Install the DSH plugin from this project packages directory, then fully reopen DSH.' }
    if ($health.contextMode -ne 'native-session-v1') { throw 'Fully exit DSH from the tray and reopen it to load the native-session plugin.' }
    if ($health.behaviorPolicy -ne 'local-config-only-v1') { throw 'Fully reopen DSH to load the local-only behavior policy before starting WeChatAgent.' }
    if ($health.imageInput -ne 'native-attachment-v1') { throw 'Fully exit DSH from the tray and reopen it to load the image attachment plugin.' }
    $bridgeEntry = Join-Path $root 'components\qq-bridge\src\social-bridge.js'
    Start-ServiceProcess 'bridge' $node ('"'+$bridgeEntry+'" "'+(Join-Path $stateDir 'bridge-config.json')+'"') (Join-Path $root 'components\qq-bridge') $bridgeEntry ([int]$config.ports.onebot) $false
    $env:PYTHONUTF8='1'; $env:PYTHONUNBUFFERED='1'
    $env:WECHATAGENT_LOG_DIR=$null; $env:WECHATAGENT_STATE_DIR=$null
    $adapterEntry = Join-Path $PSScriptRoot 'ui-service.mjs'
    Start-ServiceProcess 'adapter' $node ('"'+$adapterEntry+'"') $root $adapterEntry ([int]$config.ports.adapter) $false
    for($i=0;$i -lt 20;$i++) {
        $status=Invoke-RestMethod ('http://127.0.0.1:'+$config.ports.adapter+'/status') -TimeoutSec 3
        if($status.ob_connected -and $status.reader_connected){break}; Start-Sleep -Milliseconds 250
    }
    Show-Status $config
} finally { foreach($name in $names){[Environment]::SetEnvironmentVariable($name,$previous[$name],'Process')} }
