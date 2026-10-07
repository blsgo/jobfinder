# Registers the daily autopilot run (hunt + AI tailoring) in Windows Task Scheduler.
# Runs at 09:00 every day; if the PC was off, it runs as soon as it is back on.
# Remove any time with:  Unregister-ScheduledTask -TaskName "Job Seeker Daily" -Confirm:$false
$dir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node).Source
$action   = New-ScheduledTaskAction -Execute $node -Argument "src\run.js" -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -Daily -At 9:00am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 8)
Register-ScheduledTask -TaskName "Job Seeker Daily" -Action $action -Trigger $trigger -Settings $settings -Description "Finds, tailors and applies to high-paying AI automation jobs" -Force | Out-Null
Write-Output "Autopilot scheduled: daily at 09:00 (catches up if missed)."
