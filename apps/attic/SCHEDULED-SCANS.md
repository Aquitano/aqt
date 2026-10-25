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

A scan writes scratch copies to `temp`, which must be on another disk than the one it scans; see [Configuration](README.md#configuration). The default system temporary directory is on `C:`, so folders there need `temp` set to an existing directory on a disk that stays attached and is not in `$disks`, such as a second internal drive. Every scan reads the same `config.toml`, so a `temp` on one of the listed disks makes that disk's scans fail. When the only other disk is one of `$disks`, give the folder scans their own copy of the configuration with `temp` on that disk and pass it as `attic scan $folder --config <file>`. The disk scans keep the default on `C:`, and the folder scans then need that disk attached.

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
