$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = 'D:\Program Files\nodejs\node.exe'
Set-Location -LiteralPath $root
$env:SMART_ROUTER_DATA = Join-Path $root 'data'
$env:CC_SWITCH_DB = 'C:\Users\Admin\.cc-switch\cc-switch.db'
$log = Join-Path $root 'data\resident.log'
$mutex = New-Object System.Threading.Mutex($false, 'Global\ClaudeSmartRouterResident')
if (-not $mutex.WaitOne(0)) { exit 0 }
try {
    while ($true) {
        if ((Test-Path $log) -and (Get-Item $log).Length -gt 10MB) {
            Move-Item -LiteralPath $log -Destination ($log + '.1') -Force
        }
        Add-Content -LiteralPath $log -Value ("{0:o} Starting router" -f (Get-Date))
        try {
            & $node --disable-warning=ExperimentalWarning (Join-Path $root 'src\index.js') >> $log 2>&1
            Add-Content -LiteralPath $log -Value ("{0:o} Router exited ({1}); restarting in 5 seconds" -f (Get-Date), $LASTEXITCODE)
        } catch {
            Add-Content -LiteralPath $log -Value ("{0:o} {1}" -f (Get-Date), $_.Exception.Message)
        }
        Start-Sleep -Seconds 5
    }
} finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
