$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$mutex = New-Object System.Threading.Mutex($false, 'Global\GRI_ProgramMonitor_Supervisor')
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) { exit 0 }
try {
  New-Item -ItemType Directory -Force -Path "$PSScriptRoot\logs" | Out-Null
  while ($true) {
    foreach ($name in @('stdout', 'stderr')) {
      $log = "$PSScriptRoot\logs\$name.log"
      if ((Test-Path $log) -and (Get-Item $log).Length -gt 10MB) { Move-Item $log "$log.previous" -Force }
    }
    # Redirection removes the Node process from terminal selection / QuickEdit pauses.
    $process = Start-Process -FilePath $node -ArgumentList 'index.js' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput "$PSScriptRoot\logs\stdout.log" -RedirectStandardError "$PSScriptRoot\logs\stderr.log" -PassThru
    $process.WaitForExit()
    Start-Sleep -Seconds 15
  }
} finally { if ($owned) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
