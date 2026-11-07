<#
.SYNOPSIS
    Read-only prerequisite report for the office Windows PC planned to host self-hosted Supabase.

.DESCRIPTION
    Reports Windows, virtualization, WSL, Docker, memory, disk, power and listening-port state.
    It changes nothing: no features, packages, power, firewall, router or VPN settings, and it
    neither creates nor reads secrets. It takes no paths or commands as input.
    It does not test Supabase, sign-in-free startup, or reachability from another machine.
    See docs/SELF_HOSTED_SUPABASE.md.

    Exit code: 0 = no FAIL, 1 = at least one FAIL, 2 = not running on Windows.

.PARAMETER SelfTest
    Runs the built-in checks of the decision logic only; does not inspect the machine.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\Check-SupabaseServer.ps1
#>
[CmdletBinding()]
param([switch]$SelfTest)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$script:Counts = @{ PASS = 0; WARN = 0; FAIL = 0; INFO = 0; UNVERIFIED = 0 }

function Add-Result([string]$Status, [string]$Area, [string]$Message, [string]$Action = '') {
    $script:Counts[$Status]++
    $color = @{ PASS = 'Green'; WARN = 'Yellow'; FAIL = 'Red'; INFO = 'Gray'; UNVERIFIED = 'Cyan' }[$Status]
    Write-Host ('[{0,-10}] {1}: {2}' -f $Status, $Area, $Message) -ForegroundColor $color
    if ($Action) { Write-Host ('             Manual action: {0}' -f $Action) }
}

# ---- Decision logic: pure functions, covered by -SelfTest ----

function Get-WindowsVerdict([int]$Build, [string]$EditionId, [int]$ProductType) {
    if ($ProductType -ne 1) {
        return @{ Status = 'FAIL'; Message = 'Windows Server: Docker Desktop does not support server versions of Windows.' }
    }
    if ($Build -ge 22000) {
        if ($Build -lt 22631) { return @{ Status = 'FAIL'; Message = "Windows 11 build $Build is below the 22631 (23H2) Docker Desktop requires." } }
    } elseif ($Build -ne 19045) {
        return @{ Status = 'FAIL'; Message = "Windows build $Build is not a Docker Desktop supported build (19045 or 22631+)." }
    }
    if ($EditionId -match '^Core') {
        return @{ Status = 'WARN'; Message = "Build $Build meets Docker's minimum. Edition $EditionId (Home): Docker's requirements list omits it, but the same page says Home can run Linux containers; verify before relying on it." }
    }
    if ($EditionId -notin @('Professional', 'ProfessionalN', 'Enterprise', 'EnterpriseN', 'Education', 'EducationN')) {
        return @{ Status = 'WARN'; Message = "Edition $EditionId is not recognised; compare it with Docker's listed editions (Enterprise, Pro, Education)." }
    }
    return @{ Status = 'PASS'; Message = "Build $Build meets Docker's minimum, and edition $EditionId is on its list." }
}

function Get-FirstVersion([string]$Text) {
    $m = [regex]::Match($Text, '\d+\.\d+(\.\d+){0,2}')
    if (-not $m.Success) { return $null }
    return [version]$m.Value
}

# powercfg labels are localized, but the AC and DC indexes are always the last two hex values.
function Get-PowerIndexes([string]$Text) {
    $values = @([regex]::Matches($Text, '0x([0-9a-fA-F]+)\s*(\r?\n|$)') | ForEach-Object { [Convert]::ToInt64($_.Groups[1].Value, 16) })
    if ($values.Length -lt 2) { return $null }
    return @{ AC = $values[$values.Length - 2]; DC = $values[$values.Length - 1] }
}

function Get-DiskVerdict([double]$FreeGB, [string]$MediaType) {
    if ($FreeGB -lt 40) { return 'WARN' }
    if ($MediaType -eq 'SSD' -and $FreeGB -ge 80) { return 'PASS' }
    return 'WARN'
}

function Test-LoopbackOnly([string[]]$Addresses) {
    foreach ($a in $Addresses) { if ($a -notin @('127.0.0.1', '::1')) { return $false } }
    return $true
}

function Invoke-SelfTest {
    $failed = 0
    function Assert-Equal($Actual, $Expected, [string]$Name) {
        if ($Actual -ne $Expected) { Write-Host "not ok: $Name (got '$Actual', wanted '$Expected')"; return 1 }
        Write-Host "ok: $Name"; return 0
    }
    $sample = "Power Setting Index`r`nMinimum: 0x00000000`r`nMaximum: 0xffffffff`r`nCurrent AC Power Setting Index: 0x00000000`r`nCurrent DC Power Setting Index: 0x00000708`r`n"
    $cases = @(
        @((Get-WindowsVerdict 22631 'Professional' 1).Status, 'PASS', 'Windows 11 Pro 23H2'),
        @((Get-WindowsVerdict 26100 'Enterprise' 1).Status, 'PASS', 'Windows 11 Enterprise 24H2'),
        @((Get-WindowsVerdict 26100 'Core' 1).Status, 'WARN', 'Windows 11 Home needs verifying, not a failure'),
        @((Get-WindowsVerdict 22621 'Core' 1).Status, 'FAIL', 'Home below the minimum build still fails'),
        @((Get-WindowsVerdict 22621 'Professional' 1).Status, 'FAIL', 'Windows 11 22H2 is too old'),
        @((Get-WindowsVerdict 19045 'Professional' 1).Status, 'PASS', 'Windows 10 22H2 Pro'),
        @((Get-WindowsVerdict 19044 'Professional' 1).Status, 'FAIL', 'Windows 10 21H2 is too old'),
        @((Get-WindowsVerdict 20348 'ServerStandard' 3).Status, 'FAIL', 'Windows Server is unsupported'),
        @((Get-WindowsVerdict 26100 'SomethingNew' 1).Status, 'WARN', 'unknown edition is not passed'),
        @((Get-FirstVersion 'WSL version: 2.1.5.0'), ([version]'2.1.5.0'), 'WSL version parsed'),
        @((Get-FirstVersion 'Docker version 29.0.1, build abc'), ([version]'29.0.1'), 'Docker version parsed'),
        @(((Get-FirstVersion 'no version here') -eq $null), $true, 'missing version is null'),
        @((Get-PowerIndexes $sample).AC, 0, 'AC power index'),
        @((Get-PowerIndexes $sample).DC, 1800, 'DC power index'),
        @(((Get-PowerIndexes 'no values') -eq $null), $true, 'unreadable power output is null'),
        @((Get-DiskVerdict 500 'SSD'), 'PASS', 'large SSD'),
        @((Get-DiskVerdict 3000 'HDD'), 'WARN', 'an HDD is never a plain pass'),
        @((Get-DiskVerdict 60 'SSD'), 'WARN', 'SSD under the recommended 80 GB'),
        @((Get-DiskVerdict 10 'SSD'), 'WARN', 'SSD under the minimum 40 GB'),
        @((Get-DiskVerdict 500 'Unspecified'), 'WARN', 'unknown media is not passed'),
        @((Test-LoopbackOnly @('127.0.0.1', '::1')), $true, 'loopback listener'),
        @((Test-LoopbackOnly @('0.0.0.0')), $false, 'all-interfaces listener'),
        @((Test-LoopbackOnly @('127.0.0.1', '192.168.1.5')), $false, 'mixed listener')
    )
    foreach ($c in $cases) { $failed += Assert-Equal $c[0] $c[1] $c[2] }
    Write-Host "$($cases.Length - $failed) of $($cases.Length) passed"
    return $failed
}

# ---- Machine inspection ----

# Runs only the fixed tools and fixed arguments in this file, with a timeout so a stalled
# Docker Desktop cannot hang the report. WSL_UTF8 applies to the child process only.
function Invoke-Tool([string]$Path, [string]$Arguments, [int]$TimeoutMs = 20000) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Path
    $psi.Arguments = $Arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $psi.EnvironmentVariables['WSL_UTF8'] = '1'
    $p = [System.Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEndAsync()
    $err = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($TimeoutMs)) {
        $p.Kill()
        return @{ ExitCode = -1; TimedOut = $true; Out = ''; Err = '' }
    }
    return @{ ExitCode = $p.ExitCode; TimedOut = $false; Out = $out.Result.Trim(); Err = $err.Result.Trim() }
}

function Invoke-Check([string]$Area, [scriptblock]$Body) {
    try { & $Body } catch { Add-Result 'UNVERIFIED' $Area "Could not check: $($_.Exception.Message)" }
}

function Test-Windows {
    $os = Get-CimInstance Win32_OperatingSystem
    $reg = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $v = Get-WindowsVerdict ([int]$os.BuildNumber) ([string]$reg.EditionID) ([int]$os.ProductType)
    $action = ''
    if ($v.Status -ne 'PASS') { $action = 'Resolve this using the runbook, section 3, before installing.' }
    Add-Result $v.Status 'Windows' "$($os.Caption), $($os.OSArchitecture). $($v.Message)" $action
    $release = if ($reg.PSObject.Properties['DisplayVersion']) { [string]$reg.DisplayVersion } else { 'unknown' }
    Add-Result 'UNVERIFIED' 'Windows servicing' "Release $release, edition $($reg.EditionID): whether Microsoft still services it is not checked here, and Docker supports only serviced releases." 'Check Microsoft''s lifecycle dates (runbook, section 3).'
    if ([int]$os.BuildNumber -lt 22000) {
        Add-Result 'WARN' 'Windows' 'Windows 10 is past its normal end of support; confirm how this PC receives security updates.'
    }
}

function Test-Hardware {
    $cs = Get-CimInstance Win32_ComputerSystem
    $cpus = @(Get-CimInstance Win32_Processor)
    $gb = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
    if ($gb -lt 7.5) {
        Add-Result 'FAIL' 'Memory' "$gb GB installed; Docker Desktop lists 8 GB and Supabase recommends 8 GB or more."
    } else {
        Add-Result 'PASS' 'Memory' "$gb GB installed. By default WSL 2 may use about half of it."
    }
    $cores = ($cpus | Measure-Object -Property NumberOfCores -Sum).Sum
    if ($cores -ge 4) { Add-Result 'PASS' 'CPU' "$cores cores (Supabase recommends 4 or more)." }
    elseif ($cores -ge 2) { Add-Result 'WARN' 'CPU' "$cores cores: at Supabase's minimum of 2, below the recommended 4." }
    else { Add-Result 'FAIL' 'CPU' "$cores core; Supabase's minimum is 2." }

    # With a hypervisor running, Win32_Processor reports these flags as false, so they mean nothing then.
    if ($cs.HypervisorPresent) {
        Add-Result 'PASS' 'Virtualization' 'A hypervisor is already running, so hardware virtualization is active.'
    } elseif ($cpus[0].VirtualizationFirmwareEnabled -and $cpus[0].SecondLevelAddressTranslationExtensions) {
        Add-Result 'PASS' 'Virtualization' 'Enabled in firmware, with SLAT.'
    } else {
        Add-Result 'FAIL' 'Virtualization' 'Not reported as enabled in firmware, or SLAT is missing.' 'Enable hardware virtualization in BIOS/UEFI.'
    }
}

function Test-WindowsFeatures {
    foreach ($name in @('VirtualMachinePlatform', 'Microsoft-Windows-Subsystem-Linux')) {
        $f = Get-CimInstance Win32_OptionalFeature -Filter "Name='$name'"
        if ($f -and $f.InstallState -eq 1) { Add-Result 'PASS' 'Windows feature' "$name is enabled." }
        else { Add-Result 'WARN' 'Windows feature' "$name is not enabled." 'WSL setup enables this with admin rights; see the runbook, section 5.' }
    }
    $svc = Get-Service LanmanServer
    if ($svc.StartType -eq 'Automatic') { Add-Result 'PASS' 'Server service' "LanmanServer starts automatically (now $($svc.Status))." }
    else { Add-Result 'FAIL' 'Server service' "LanmanServer start mode is $($svc.StartType); Docker Desktop requires Automatic." 'Change it in services.msc.' }
}

function Test-Disks {
    $largest = 0
    foreach ($d in @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3')) {
        $free = [math]::Round($d.FreeSpace / 1GB, 0)
        $total = [math]::Round($d.Size / 1GB, 0)
        if ($free -gt $largest) { $largest = $free }
        $media = 'Unspecified'; $health = 'unknown'
        try {
            $number = (Get-Partition -DriveLetter ($d.DeviceID.Substring(0, 1)) | Select-Object -First 1).DiskNumber
            $pd = Get-PhysicalDisk | Where-Object { $_.DeviceId -eq "$number" } | Select-Object -First 1
            if ($pd) { $media = [string]$pd.MediaType; $health = [string]$pd.HealthStatus }
        } catch { $media = 'Unspecified' }
        $system = ''
        if ($d.DeviceID -eq $env:SystemDrive) { $system = ' (system drive; default home of WSL and Docker data)' }
        $status = Get-DiskVerdict $free $media
        $note = ''
        if ($media -eq 'HDD') { $note = ' Supabase states SSD; see the HDD evaluation in the runbook, section 4.' }
        elseif ($media -eq 'Unspecified') { $note = ' Media type unknown; confirm it by hand.' }
        if ($free -lt 40) { $note += ' Under the 40 GB minimum.' }
        elseif ($free -lt 80) { $note += ' Under the 80 GB recommended.' }
        Add-Result $status "Disk $($d.DeviceID)" "$free GB free of $total GB, media $media, health $health$system.$note"
    }
    if ($largest -lt 40) { Add-Result 'FAIL' 'Disk' 'No fixed drive has the 40 GB Supabase requires as a minimum.' 'Free space or add a drive.' }
    Add-Result 'UNVERIFIED' 'Disk' 'Which drive holds the WSL distribution and Docker data is not checked here.' 'Confirm it after installing (runbook, section 4).'
}

function Test-Wsl {
    $wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
    if (-not (Test-Path -LiteralPath $wsl)) {
        Add-Result 'FAIL' 'WSL' 'wsl.exe is not present.' 'Install WSL by hand; see the runbook, section 5.'
        return
    }
    $r = Invoke-Tool $wsl '--version'
    $version = $null
    if ($r.ExitCode -eq 0) { $version = Get-FirstVersion ($r.Out -split "`n")[0] }
    if ($null -eq $version) {
        Add-Result 'FAIL' 'WSL' 'wsl --version gave no version: WSL is missing or is the old inbox build.' 'Install or update WSL by hand; see the runbook, section 5.'
        return
    }
    if ($version -ge [version]'2.1.5') { Add-Result 'PASS' 'WSL' "Version $version (Docker Desktop requires 2.1.5 or later)." }
    else { Add-Result 'FAIL' 'WSL' "Version $version is below the 2.1.5 Docker Desktop requires." 'Run wsl --update by hand.' }

    $r = Invoke-Tool $wsl '--list --verbose'
    $distros = @()
    if ($r.ExitCode -eq 0) {
        $distros = @($r.Out -split "`r?`n" | Select-Object -Skip 1 | Where-Object { $_.Trim() -and $_ -notmatch 'docker-desktop' })
    }
    if ($distros.Length -eq 0) { Add-Result 'WARN' 'WSL' 'No Linux distribution besides any docker-desktop one.' 'One is needed to hold the deployment; see the runbook, section 5.' }
    else { foreach ($d in $distros) { Add-Result 'INFO' 'WSL distribution' ($d.Trim() -replace '\s+', ' ') } }
}

function Test-Docker {
    $cmd = Get-Command docker.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) {
        Add-Result 'FAIL' 'Docker' 'docker.exe is not on PATH: Docker Desktop is not installed, or is not set up for this user.' 'Check licensing first, then install by hand; see the runbook, section 5.'
        return
    }
    $r = Invoke-Tool $cmd.Source '--version'
    if ($r.ExitCode -eq 0) { Add-Result 'INFO' 'Docker' $r.Out } else { Add-Result 'UNVERIFIED' 'Docker' 'docker --version failed.' }

    $r = Invoke-Tool $cmd.Source 'compose version'
    if ($r.ExitCode -eq 0) { Add-Result 'PASS' 'Docker Compose' $r.Out }
    else { Add-Result 'FAIL' 'Docker Compose' 'docker compose is unavailable.' 'Repair the Docker Desktop install.' }

    $r = Invoke-Tool $cmd.Source 'info --format "{{.OSType}}|{{.NCPU}}|{{.MemTotal}}"'
    if ($r.TimedOut -or $r.ExitCode -ne 0) {
        Add-Result 'UNVERIFIED' 'Docker engine' 'The engine did not answer, so Linux containers could not be confirmed.' 'Start Docker Desktop and run this again.'
    } else {
        $parts = $r.Out -split '\|'
        if ($parts[0] -eq 'linux') {
            Add-Result 'PASS' 'Docker engine' ('Running Linux containers with {0} CPUs and {1} GB.' -f $parts[1], [math]::Round([double]$parts[2] / 1GB, 1))
        } else {
            Add-Result 'FAIL' 'Docker engine' "Engine type is '$($parts[0])'; Supabase needs Linux containers." 'Switch Docker Desktop to Linux containers.'
        }
    }
    Add-Result 'INFO' 'Docker licence' 'Not checkable here. Free use requires fewer than 250 employees AND under $10M revenue; government entities need a paid plan.' 'Confirm your organisation''s entitlement.'
}

function Test-Power {
    $powercfg = Join-Path $env:SystemRoot 'System32\powercfg.exe'
    $checks = @(
        @('Sleep', 'SUB_SLEEP STANDBYIDLE', 'The server stops answering while asleep.'),
        @('Hibernate', 'SUB_SLEEP HIBERNATEIDLE', 'The server stops answering while hibernated.'),
        @('Disk idle-off', 'SUB_DISK DISKIDLE', 'A spun-down HDD adds delay to database writes.')
    )
    foreach ($c in $checks) {
        $r = Invoke-Tool $powercfg "/query SCHEME_CURRENT $($c[1])"
        $i = $null
        if ($r.ExitCode -eq 0) { $i = Get-PowerIndexes $r.Out }
        if ($null -eq $i) { Add-Result 'UNVERIFIED' "Power: $($c[0])" 'Windows did not report this setting.'; continue }
        if ($i.AC -eq 0) { Add-Result 'PASS' "Power: $($c[0])" 'Never on mains power.' }
        else { Add-Result 'WARN' "Power: $($c[0])" "After $($i.AC) seconds on mains power. $($c[2])" 'Review it by hand in Power Options; this script does not change it.' }
    }
    # Only this flag is read; the stored auto sign-in password value is never touched.
    $auto = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name AutoAdminLogon -ErrorAction SilentlyContinue)
    $enabled = $auto -and "$($auto.AutoAdminLogon)" -eq '1'
    Add-Result 'INFO' 'Sign-in' "Automatic Windows sign-in is $(if ($enabled) { 'on' } else { 'off' }). Docker Desktop's documented autostart is at user sign-in."
    Add-Result 'UNVERIFIED' 'Restart recovery' 'Whether the stack returns after restart, power loss or update is not tested here.' 'Run the restart tests in the runbook, section 7.'
}

function Test-Ports {
    $sensitive = @('5432', '6543', '8000', '8443')
    $names = @{
        '80' = 'HTTP proxy'; '443' = 'HTTPS proxy'; '5432' = 'Postgres session pooler'; '6543' = 'Postgres transaction pooler'
        '8000' = 'API gateway and Studio'; '8443' = 'Kong HTTPS'; '54321' = 'Supabase CLI dev stack'; '54322' = 'Supabase CLI dev stack'; '54323' = 'Supabase CLI dev stack'
    }
    foreach ($port in @('80', '443', '5432', '6543', '8000', '8443', '54321', '54322', '54323')) {
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$port) -ErrorAction SilentlyContinue)
        if ($listeners.Length -eq 0) { continue }
        $addresses = @($listeners | ForEach-Object { $_.LocalAddress } | Select-Object -Unique)
        $owners = @($listeners | ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessName } } | Select-Object -Unique) -join ', '
        $text = "$port ($($names[$port])) listening on $($addresses -join ', ') by $owners."
        if ([int]$port -ge 54321) {
            Add-Result 'WARN' 'Port' $text 'This looks like the CLI development stack, which must not be exposed. Do not use it as the server.'
        } elseif (Test-LoopbackOnly $addresses) {
            Add-Result 'PASS' 'Port' "$text Local only."
        } elseif ($sensitive -contains $port) {
            Add-Result 'WARN' 'Port' "$text Reachable beyond this PC unless blocked." 'Bind it to 127.0.0.1 (runbook, section 6) and test from outside.'
        } else {
            Add-Result 'WARN' 'Port' "$text Confirm this is the VPN-only HTTPS proxy, or another program." 'See the runbook, section 9.'
        }
    }
    $wanted = @($names.Keys)
    $rules = @{}
    foreach ($rule in @(Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True)) { $rules[$rule.InstanceID] = $rule }
    foreach ($f in @(Get-NetFirewallPortFilter -All)) {
        if (-not $rules.ContainsKey($f.InstanceID)) { continue }
        $hits = @(@($f.LocalPort) | Where-Object { $wanted -contains "$_" })
        if ($hits.Length -gt 0) { Add-Result 'INFO' 'Firewall' "Inbound allow rule '$($rules[$f.InstanceID].DisplayName)' covers port(s) $($hits -join ', ')." }
    }
    foreach ($rule in $rules.Values) {
        if ($rule.DisplayName -match 'docker|wsl') { Add-Result 'INFO' 'Firewall' "Inbound allow rule '$($rule.DisplayName)' (profile $($rule.Profile))." }
    }
    Add-Result 'UNVERIFIED' 'Exposure' 'A local listener and firewall list do not prove what other machines can reach.' 'Test from LAN, VPN and internet (runbook, section 9).'
}

# ---- Entry point ----

if ($SelfTest) { exit ([int][bool](Invoke-SelfTest)) }

if ($env:OS -ne 'Windows_NT') {
    Write-Host 'This report only runs on Windows. Use -SelfTest to check its logic elsewhere.'
    exit 2
}

Write-Host 'AV Backup: office server prerequisite report (read-only; nothing is changed)'
Write-Host ''
Invoke-Check 'Windows' { Test-Windows }
Invoke-Check 'Hardware' { Test-Hardware }
Invoke-Check 'Windows features' { Test-WindowsFeatures }
Invoke-Check 'Disk' { Test-Disks }
Invoke-Check 'WSL' { Test-Wsl }
Invoke-Check 'Docker' { Test-Docker }
Invoke-Check 'Power' { Test-Power }
Invoke-Check 'Ports' { Test-Ports }

$c = $script:Counts
Write-Host ''
Write-Host ("Summary: {0} PASS, {1} WARN, {2} FAIL, {3} UNVERIFIED, {4} INFO" -f $c.PASS, $c.WARN, $c.FAIL, $c.UNVERIFIED, $c.INFO)
Write-Host 'This report does not show that Supabase is installed, healthy, or safely reachable.'
if ($c.FAIL -gt 0) { exit 1 }
exit 0
