param([switch]$SelfTest, [switch]$FixtureTest, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
$metadata = Join-Path $env:WINDIR 'System32\WinMetadata'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework 4.x x64 compiler is required.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root 'state\ui-host' }
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$output = Join-Path $outputDirectory 'WechatVisualProbe.exe'
$references = @(
    (Join-Path $framework 'System.Web.Extensions.dll'),
    (Join-Path $framework 'System.Drawing.dll'),
    (Join-Path $framework 'System.Runtime.WindowsRuntime.dll'),
    (Join-Path $metadata 'Windows.Foundation.winmd'),
    (Join-Path $metadata 'Windows.Storage.winmd'),
    (Join-Path $metadata 'Windows.Graphics.winmd'),
    (Join-Path $metadata 'Windows.Globalization.winmd'),
    (Join-Path $metadata 'Windows.Media.winmd')
)
foreach ($assembly in @('System.Runtime', 'System.Runtime.InteropServices.WindowsRuntime', 'System.ObjectModel')) {
    $assemblyRoot = Join-Path $env:WINDIR ('Microsoft.NET\assembly\GAC_MSIL\' + $assembly)
    $resolved = Get-ChildItem -LiteralPath $assemblyRoot -Filter ($assembly + '.dll') -Recurse -File -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $resolved) { throw ('Required Windows OCR assembly is missing: ' + $assembly) }
    $references += $resolved.FullName
}
foreach ($reference in $references) {
    if (-not (Test-Path -LiteralPath $reference)) { throw ('Required Windows OCR reference is missing: ' + [IO.Path]::GetFileName($reference)) }
}
$arguments = @('/nologo','/target:exe','/platform:x64','/optimize+','/warn:4',('/out:' + $output))
$arguments += $references | ForEach-Object { '/reference:' + $_ }
$arguments += Join-Path $PSScriptRoot 'native-ui\WechatVisualProbe.cs'
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'Visual probe compilation failed.' }
if ($SelfTest) { & $output --self-test; if ($LASTEXITCODE -ne 0) { throw 'Visual probe self-test failed.' } }
if ($FixtureTest) { & $output --fixture-test; if ($LASTEXITCODE -ne 0) { throw 'Offline OCR fixture test failed.' } }
Write-Output ('Visual probe built: ' + $output)
Write-Output 'Read-only local image OCR. No window was captured and no input was sent.'
