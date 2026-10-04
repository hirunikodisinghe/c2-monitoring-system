# Run once in an Administrator PowerShell after npm install and .env setup.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'Run-Monitor.ps1'
if (-not (Test-Path (Join-Path $PSScriptRoot '.env'))) { throw 'Copy your existing .env into this folder first.' }
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
Write-Host 'Enter the Windows account password (not PIN). Task Scheduler needs it to run after restart without login. Use the account that owns the WhatsApp session.'
$cred = Get-Credential -UserName $identity -Message 'Windows account for unattended C2 monitor'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $script + '"') -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'GRI ST3 C2 WhatsApp Monitor' -Action $action -Trigger $trigger -Settings $settings -User $cred.UserName -Password $cred.GetNetworkCredential().Password -Description 'Oracle C2 alerts and WhatsApp status dashboard' -Force | Out-Null
Start-ScheduledTask -TaskName 'GRI ST3 C2 WhatsApp Monitor'
Write-Host 'Installed. Open http://localhost:8080 and link WhatsApp if asked.'
