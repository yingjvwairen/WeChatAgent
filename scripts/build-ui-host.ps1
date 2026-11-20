param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework 4.x x64 compiler is required.' }
$source = Join-Path $PSScriptRoot 'native-ui\WechatUiHost.cs'
$outputDirectory = Join-Path $root 'state\ui-host'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$output = Join-Path $outputDirectory 'WechatUiHost.exe'
$references = @(
    (Join-Path $framework 'System.Web.Extensions.dll'),
    (Join-Path $framework 'System.Windows.Forms.dll'),
    (Join-Path $framework 'WPF\WindowsBase.dll'),
    (Join-Path $framework 'WPF\UIAutomationClient.dll'),
    (Join-Path $framework 'WPF\UIAutomationTypes.dll')
)
foreach ($reference in $references) {
    if (-not (Test-Path -LiteralPath $reference)) { throw ('Required .NET reference is missing: ' + [IO.Path]::GetFileName($reference)) }
}
$arguments = @('/nologo','/target:exe','/platform:x64','/optimize+','/warn:4',('/out:' + $output))
$arguments += $references | ForEach-Object { '/reference:' + $_ }
$arguments += $source
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'UI host compilation failed.' }
if ($SelfTest) {
    & $output --self-test
    if ($LASTEXITCODE -ne 0) { throw 'UI host self-test failed.' }
}
Write-Output ('UI host built: ' + $output)
Write-Output 'Input is disabled by default. No application was opened and no input was sent.'
