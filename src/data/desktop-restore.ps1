param([Parameter(Mandatory=$true)][string]$PlanPath)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$utf8 = [Text.UTF8Encoding]::new($false)
$task = Split-Path -Parent ([IO.Path]::GetFullPath($PlanPath))
$ownership = $null; $imageLock = $null; $plan = $null; $journal = $null; $journalValid = $false
function Save-Json($path, $value) {
    $temp = $path + '.tmp'
    [IO.File]::WriteAllText($temp, ($value | ConvertTo-Json -Depth 20 -Compress), $utf8)
    if ([IO.File]::Exists($path)) { [IO.File]::Replace($temp, $path, [NullString]::Value) }
    else { [IO.File]::Move($temp, $path) }
}
function Status($phase, $code = '') {
    Save-Json (Join-Path $task 'status.json') @{ id=$plan.id; phase=$phase; code=$code; replacedDir=$plan.pending.replacedDir }
}
function Exists($path) { return [IO.File]::Exists($path) -or [IO.Directory]::Exists($path) }
function Safe-Path($base, $relative) {
    # Win32 aliases, ADS, device names and case collisions cannot enter a recovery plan.
    if ($relative -match '[\\:\x00-\x1f]' -or $relative.StartsWith('/')) { throw 'restore_path_rejected' }
    foreach ($part in $relative.Split('/')) {
        if (!$part -or $part -eq '.' -or $part -eq '..' -or $part -match '[. ]$' -or $part -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') { throw 'restore_path_rejected' }
    }
    $candidate = $base
    foreach ($part in $relative.Split('/')) {
        $candidate = Join-Path $candidate $part
        if (Exists $candidate) {
            if ((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'restore_path_rejected' }
        }
    }
    return $candidate
}
function Hash($path) { return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Move-Path($source, $destination) {
    if (Exists $destination) { throw 'restore_destination_exists' }
    [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
    if ([IO.Directory]::Exists($source)) { [IO.Directory]::Move($source, $destination) }
    else { [IO.File]::Move($source, $destination) }
}
function Host-Running {
    $original = Get-Process -Id $plan.hostPid -ErrorAction SilentlyContinue
    if ($original -and $original.Path -ieq $plan.executable) { return $true }
    $name = [IO.Path]::GetFileNameWithoutExtension($plan.executable)
    foreach ($process in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
        try { if ([IO.Path]::GetFullPath($process.Path) -ieq $plan.executable) { return $true } }
        catch { throw 'restore_process_check_failed' }
    }
    return $false
}
function Restore-Profile {
    $saved = Join-Path $task 'profile.before'
    if ($journal.profileExisted) {
        $temp = $desktopPatch + '.nexus-restore.tmp'; [IO.File]::Copy($saved, $temp, $true)
        if ([IO.File]::Exists($desktopPatch)) { [IO.File]::Replace($temp, $desktopPatch, [NullString]::Value) } else { [IO.File]::Move($temp, $desktopPatch) }
    } elseif ([IO.File]::Exists($desktopPatch)) { [IO.File]::Delete($desktopPatch) }
}
function Rollback {
    # Derive each rename's completion from both locations, covering a crash before journal persistence.
    $rows = @($journal.rows); [array]::Reverse($rows)
    foreach ($row in $rows) {
        $live = Safe-Path $plan.home $row.root; $staged = Safe-Path $staging $row.root; $kept = Safe-Path $replaced $row.root
        if (!(Exists $staged) -and $row.incoming -and (Exists $live)) { Move-Path $live $staged }
        if (Exists $kept) { Move-Path $kept $live }
        if ($row.existed -and !(Exists $live)) { throw 'restore_rollback_failed' }
    }
    Restore-Profile
    $journal.phase = 'rolled-back'; Save-Json $journalPath $journal
    Remove-Item -LiteralPath (Join-Path $plan.home 'import-pending.json') -Force -ErrorAction SilentlyContinue
    Status 'rolled-back' 'restore_rolled_back'
}
try {
    $ownership = [IO.File]::Open((Join-Path $task 'worker.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($plan.version -ne 1 -or $plan.id -notmatch '^[a-f0-9]{32}$' -or (Split-Path -Leaf $task) -cne $plan.id -or $plan.pending.replacedDir -notmatch '^replaced-[0-9a-z-]+$') { throw 'restore_state_invalid' }
    $plan.home = [IO.Path]::GetFullPath($plan.home)
    if ((Split-Path -Parent (Split-Path -Parent $task)) -ine $plan.home) { throw 'restore_state_invalid' }
    $plan.executable = [IO.Path]::GetFullPath($plan.executable)
    if ([IO.Path]::GetExtension($plan.executable) -ine '.exe' -or !(Test-Path -LiteralPath $plan.executable -PathType Leaf)) { throw 'restore_state_invalid' }
    $roots = @($plan.pending.roots)
    if (!$roots.Count) { $roots = @('sessions','storages','.credentials.yaml') }
    if (!($roots -contains 'sessions') -or !($roots -contains 'storages') -or @($roots | Select-Object -Unique).Count -ne $roots.Count) { throw 'restore_state_invalid' }
    foreach ($root in $roots) { if ($root -cnotin @('sessions','storages','.credentials.yaml')) { throw 'restore_path_rejected' } }
    $staging = Safe-Path $plan.home 'import-staging'
    $replaced = Safe-Path $plan.home $plan.pending.replacedDir
    $desktopPatch = Safe-Path $plan.home 'profiles/desktop/cordis.patch.yml'
    $journalPath = Join-Path $task 'journal.json'
    $guard = '# Nexus desktop recovery ' + $plan.id + "`nNexusRecoveryInProgress: [`n"
    $oldStatus = Get-Content -LiteralPath (Join-Path $task 'status.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($oldStatus.phase -in @('completed','cancelled','rolled-back')) { Write-Host 'This recovery has already finished.'; exit 0 }
    [IO.File]::WriteAllText((Join-Path $task 'ready'), '', $utf8)
    Write-Host 'Nexus desktop recovery / Nexus 桌面恢复'
    Write-Host '请从桌面端的托盘菜单完全退出 DSH。助手不会强制停止任何任务。'
    Write-Host '重试入口：' (Join-Path (Split-Path -Parent $task) 'continue.cmd')
    if ([IO.File]::Exists($journalPath)) {
        $journal = Get-Content -LiteralPath $journalPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($journal.phase -notin @('prepared','moving','committed','rolled-back') -or $journal.profileExisted -isnot [bool] -or @($journal.rows).Count -ne $roots.Count) { throw 'restore_state_invalid' }
        $seenRoots = @{}
        foreach ($row in $journal.rows) {
            if ($row.root -cnotin $roots -or $seenRoots.ContainsKey($row.root) -or $row.existed -isnot [bool] -or $row.incoming -isnot [bool]) { throw 'restore_state_invalid' }
            $seenRoots[$row.root] = $true
        }
    }
    $journalValid = $true
    $deadline = [DateTime]::UtcNow.AddMinutes(15)
    while ($true) {
        if (!$journal -and [IO.File]::Exists((Join-Path $task 'cancel'))) {
            Remove-Item -LiteralPath (Join-Path $plan.home 'import-pending.json') -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
            Status 'cancelled'; exit 0
        }
        if (![bool](Host-Running)) {
            try { $imageLock = [IO.File]::Open($plan.executable, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None) } catch { $imageLock = $null }
            if ($imageLock -and !(Host-Running)) { break }
            if ($imageLock) { $imageLock.Dispose(); $imageLock=$null }
        }
        if ([DateTime]::UtcNow -gt $deadline) { throw 'restore_wait_timeout' }
        Start-Sleep -Milliseconds 500
    }
    # Recovery after a stopped worker always rolls back incomplete renames before permitting startup.
    if ($journal) {
        if ($journal.phase -eq 'committed') {
            Restore-Profile
            Remove-Item -LiteralPath (Join-Path $plan.home 'import-pending.json') -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
            Status 'completed'
        }
        elseif ($journal.phase -eq 'rolled-back') { Restore-Profile; Status 'rolled-back' }
        else { Rollback }
    } else {
        if ([IO.File]::Exists((Join-Path $task 'cancel'))) { throw 'restore_cancelled' }
        # Revalidate the exact plaintext files staged by the authenticated importer.
        $expected = @{}; [long]$total = 0
        foreach ($file in @($plan.pending.files)) {
            if ($expected.ContainsKey($file.path) -or $file.sha256 -notmatch '^[a-f0-9]{64}$' -or $file.size -lt 0) { throw 'restore_state_invalid' }
            $allowed = $false
            foreach ($root in $roots) { if ($file.path -ceq $root -or $file.path.StartsWith($root + '/', [StringComparison]::Ordinal)) { $allowed=$true } }
            if (!$allowed) { throw 'restore_path_rejected' }
            $path = Safe-Path $staging $file.path
            if (!(Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -ne $file.size -or (Hash $path) -cne $file.sha256) { throw 'restore_staging_changed' }
            $total += $file.size; $expected[$file.path] = $true
        }
        if ($total -gt 536870912 -or $expected.Count -gt 30000 -or (($roots -contains '.credentials.yaml') -and !$expected.ContainsKey('.credentials.yaml'))) { throw 'restore_state_invalid' }
        $actual = @(Get-ChildItem -LiteralPath $staging -File -Force -Recurse)
        if ($actual.Count -ne $expected.Count) { throw 'restore_staging_changed' }
        foreach ($entry in @(Get-ChildItem -LiteralPath $staging -Force -Recurse)) {
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'restore_path_rejected' }
        }
        if (Exists $replaced) { throw 'restore_destination_exists' }
        $rows = @()
        foreach ($root in $roots) {
            $rows += @{ root=$root; existed=(Exists (Safe-Path $plan.home $root)); incoming=(Exists (Safe-Path $staging $root)) }
        }
        $patchExisted = [IO.File]::Exists($desktopPatch)
        if ($patchExisted) { [IO.File]::Copy($desktopPatch,(Join-Path $task 'profile.before'),$true) }
        $journal = @{ phase='prepared'; profileExisted=$patchExisted; rows=$rows }
        Save-Json $journalPath $journal
        [IO.File]::WriteAllText($desktopPatch + '.nexus-restore.tmp', $guard, $utf8)
        if ($patchExisted) { [IO.File]::Replace($desktopPatch + '.nexus-restore.tmp',$desktopPatch,[NullString]::Value) } else { [IO.File]::Move($desktopPatch + '.nexus-restore.tmp',$desktopPatch) }
        Status 'restoring'
        $journal.phase = 'moving'; Save-Json $journalPath $journal
        foreach ($row in $rows) {
            $live=Safe-Path $plan.home $row.root; $staged=Safe-Path $staging $row.root; $kept=Safe-Path $replaced $row.root
            if ($row.existed) { Move-Path $live $kept }
            if ($row.incoming) { Move-Path $staged $live }
        }
        $journal.phase = 'committed'; Save-Json $journalPath $journal
        Restore-Profile
        Remove-Item -LiteralPath (Join-Path $plan.home 'import-pending.json') -Force
        Remove-Item -LiteralPath $staging -Recurse -Force
        Status 'completed'
    }
    $imageLock.Dispose(); $imageLock=$null
    $env:DSH_HOME = $plan.home
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    try { Start-Process -FilePath $plan.executable | Out-Null } catch { Status $(if ($journal.phase -eq 'rolled-back') { 'rolled-back' } else { 'completed' }) 'restore_restart_failed' }
    Write-Host '恢复流程已结束；原数据已保留。'
} catch {
    $code = $_.Exception.Message
    if ($code -notmatch '^restore_[a-z_]+$') { $code='restore_io_failed' }
    if ($plan) {
        if ($journalValid -and $journal -and $imageLock -and $journal.phase -ne 'committed') {
            try { Rollback; Write-Host '恢复失败，已回退原数据。' }
            catch { Status 'failed' 'restore_rollback_failed'; Write-Host '回退尚未完成。请关闭占用数据的程序，再运行 continue.cmd。启动保护保留。' }
        } else { Status 'failed' $code; Write-Host '恢复未完成：' $code }
    }
    Write-Host '请重新运行 nexus-restore\continue.cmd 重试。不要手工删除启动保护或原数据。'
    exit 1
} finally {
    if ($imageLock) { $imageLock.Dispose() }
    if ($ownership) { $ownership.Dispose() }
}
