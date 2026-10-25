# Scheduled scans

A scan rehashes only what changed, so one nightly run keeps the catalogue current. The first scan of a disk hashes every file and can take hours; later runs take seconds to minutes.

## Windows

Save this as `%LOCALAPPDATA%\attic\scan-nightly.ps1` and edit the two lists:

```powershell
$folders = @("$env:USERPROFILE\Documents")   # folders on internal drives, scanned every night
$disks = @('Data')                           # external disks by label, scanned when attached

foreach ($folder in $folders) { attic scan $folder }
foreach ($volume in attic volumes --json | ConvertFrom-Json) {
    if ($volume.label -in $disks -and $volume.mounted_at) { attic scan $volume.mounted_at --volume $volume.id }
}
```

A scan writes scratch copies to `temp`, which must be on another disk than the folder. The default system temporary directory is on `C:`, so scanning a folder there needs `temp` in `config.toml` set to an existing directory on another disk; see [Configuration](README.md#configuration). External disks scan with the default.

List external disks by label rather than scanning every attached volume: once a folder on `C:` has been scanned, `C:` is a known volume too, and scanning its root would index the whole system drive. A disk's label appears in `attic volumes` after its first scan. `--volume` confirms the catalogue volume the loop picked, so a disk whose USB bridge reports no serial does not stop on an identity question every night.

Register the script as a nightly task:

```powershell
$action = New-ScheduledTaskAction -Execute pwsh `
    -Argument "-NoProfile -WindowStyle Hidden -File `"$env:LOCALAPPDATA\attic\scan-nightly.ps1`""
$trigger = New-ScheduledTaskTrigger -Daily -At 2am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit 0 `
    -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'attic nightly scan' -TaskPath '\aqt\' -Action $action `
    -Trigger $trigger -Settings $settings
```

The task runs while you are signed in, and `-StartWhenAvailable` catches up after a night the PC was off. The catalogue database must be running. Each scan writes a log to `%LOCALAPPDATA%\attic\logs`, and `attic scans` lists the runs. `Start-ScheduledTask -TaskPath '\aqt\' -TaskName 'attic nightly scan'` runs it once now.

## macOS

`attic scan` works on Windows only for now: identifying a disk uses Windows volume APIs. On macOS the same loop would run from a launchd job once that support exists.
