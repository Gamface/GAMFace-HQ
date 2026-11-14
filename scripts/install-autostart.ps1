# Registers a Windows scheduled task that starts GAMFace HQ when you log in
# and restarts it if it crashes. Run in PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
# Remove it with:  Unregister-ScheduledTask -TaskName "GAMFace HQ" -Confirm:$false

$root = Split-Path -Parent $PSScriptRoot
$python = (Get-Command python -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path (Join-Path $root "logs") | Out-Null

$action = New-ScheduledTaskAction -Execute "cmd.exe" `
    -Argument "/c `"`"$python`" -m hq.server >> logs\hq.log 2>&1`"" `
    -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName "GAMFace HQ" -Action $action -Trigger $trigger `
    -Settings $settings -Description "Local multi-agent Mission Control" -Force | Out-Null
Start-ScheduledTask -TaskName "GAMFace HQ"
Write-Host "GAMFace HQ will start at every login. Dashboard: http://127.0.0.1:3030"
