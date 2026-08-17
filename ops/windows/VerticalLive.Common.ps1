<#
.SYNOPSIS
  Shared helpers for the vertical-live Windows ops scripts (TASK_SPECS §T17).

.DESCRIPTION
  Dot-sourced by Register-VerticalLive.ps1, Unregister-VerticalLive.ps1 and
  Start-VerticalLive.ps1. Nothing here touches a secret: the vault (T3) is the
  system of record for every credential, and the ops scripts never read one.

  Windows PowerShell 5.1 is the target (the shell that ships with Windows 11),
  so no pipeline chain operators, no ternaries and no null-coalescing.
#>

Set-StrictMode -Version Latest

# `Get-VLPortOwner` needs NetTCPIP. Auto-loading it happens in the global scope,
# where a `-WhatIf` run announces every alias the module defines ("What if:
# Performing the operation New Alias ..."), which reads like this script is about
# to change something. It is a read-only dependency, so it is imported once here
# with the global preference suppressed and restored.
$vlGlobalWhatIf = $global:WhatIfPreference
$global:WhatIfPreference = $false
try {
    Import-Module NetTCPIP -ErrorAction SilentlyContinue | Out-Null
} finally {
    $global:WhatIfPreference = $vlGlobalWhatIf
}

function Get-VerticalLiveRepoRoot {
    param([Parameter(Mandatory = $true)][string] $ScriptRoot)
    return (Resolve-Path (Join-Path $ScriptRoot '..\..')).Path
}

function Write-VLLog {
    param(
        [Parameter(Mandatory = $true)][string] $Message,
        [ValidateSet('info', 'warn', 'error')][string] $Level = 'info',
        [string] $LogFile
    )
    # UTC, ISO 8601 — the same clock convention the server persists with
    # (spec §10.2), so a host log line lines up with a server log line.
    $line = '{0} [{1}] {2}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ'), $Level, $Message
    if ($Level -eq 'error') { Write-Host $line -ForegroundColor Red }
    elseif ($Level -eq 'warn') { Write-Host $line -ForegroundColor Yellow }
    else { Write-Host $line }
    # A dry run writes no file: -WhatIf is for previewing what the script would
    # change, and a preview that appends to the operations log would itself be a
    # change (and would fill the console with "What if: Add Content" lines).
    if ($LogFile -and -not $WhatIfPreference) {
        $directory = Split-Path -Parent $LogFile
        if (-not (Test-Path $directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
        Add-Content -Path $LogFile -Value $line -Encoding utf8
    }
}

function Get-VerticalLiveOpsConfig {
    <#
      The resolved runtime view (ports, URLs, paths, switches) from the server's
      own config loaders.

      Review round 1, M1: this used to read config/default.json directly, which
      ignored the documented env overrides (VL_OBS_PROCESS_ENABLED,
      VL_RENDERER_STATIC_PORT/_HOST, VL_OBS_URL, VL_PORT) — the launcher could
      refuse to start OBS the operator had enabled, or wait on a different port
      from the one the process it started was listening on. Asking the Node
      loaders keeps one definition of what an override means; this process
      inherits the environment, so the child sees the same variables.
    #>
    param(
        [Parameter(Mandatory = $true)][string] $RepoRoot,
        [Parameter(Mandatory = $true)][string] $NodeExe
    )
    $entry = Join-Path $RepoRoot 'apps\server\dist\bin\ops-config.js'
    if (-not (Test-Path $entry)) {
        throw "ops config entry point not found: $entry (run npm run build)"
    }
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $NodeExe $entry 2>&1 | ForEach-Object { $_.ToString() }
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($exitCode -ne 0) {
        throw "ops config failed (exit $exitCode): $(($output | Out-String).Trim())"
    }
    try {
        return ($output | Out-String | ConvertFrom-Json)
    } catch {
        throw "ops config output was not JSON: $(($output | Out-String).Trim())"
    }
}

function Get-VerticalLiveNodeExe {
    param([string] $NodeExe)
    if ($NodeExe) {
        if (-not (Test-Path $NodeExe)) { throw "node not found at $NodeExe" }
        return (Resolve-Path $NodeExe).Path
    }
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $command) { $command = Get-Command node -ErrorAction SilentlyContinue }
    if ($null -eq $command) { throw 'node was not found on PATH; pass -NodeExe <path to node.exe>' }
    return $command.Source
}

function Get-VLPortOwner {
    <#
      Who is listening on a loopback port: @{ Found; ProcessId; Name; CommandLine }.

      Review round 1, M2: an open port is not evidence that *our* component is
      running. Another worktree on this host listens on the same loopback ports,
      and so does any unrelated process that happened to take them. `CommandLine`
      is $null when it cannot be read, and callers treat unknown as "not ours".
    #>
    param([Parameter(Mandatory = $true)][int] $Port)

    # This function only reads. Auto-loading NetTCPIP under -WhatIf would
    # otherwise announce every alias the module defines.
    $WhatIfPreference = $false
    $result = @{ Found = $false; ProcessId = $null; Name = $null; CommandLine = $null }
    $owningPid = $null

    $getConnection = Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue
    if ($null -ne $getConnection) {
        try {
            $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
                Select-Object -First 1
            if ($null -ne $listener) { $owningPid = [int]$listener.OwningProcess }
        } catch {
            $owningPid = $null
        }
    }
    if ($null -eq $owningPid) {
        # Fallback for hosts without the NetTCPIP module.
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $rows = & netstat.exe -ano 2>&1 | ForEach-Object { $_.ToString() }
        } finally {
            $ErrorActionPreference = $previous
        }
        foreach ($row in $rows) {
            if ($row -match "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$") {
                $owningPid = [int]$Matches[1]
                break
            }
        }
    }
    if ($null -eq $owningPid) { return $result }

    $result.Found = $true
    $result.ProcessId = $owningPid
    try {
        $process = Get-Process -Id $owningPid -ErrorAction Stop
        $result.Name = $process.ProcessName
    } catch {
        $result.Name = $null
    }
    try {
        $info = Get-CimInstance Win32_Process -Filter "ProcessId=$owningPid" -ErrorAction Stop
        if ($null -ne $info) { $result.CommandLine = $info.CommandLine }
    } catch {
        $result.CommandLine = $null
    }
    return $result
}

function Test-VLHttpOk {
    <#
      Readiness for the static page: HTTP 200. Anything else — a 404 from an
      unrelated server, a connection refused — is not ready.
    #>
    param(
        [Parameter(Mandatory = $true)][string] $Url,
        [int] $TimeoutSec = 5
    )
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -Method Get
        return ([int]$response.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Test-VLServerHealth {
    <#
      Readiness for the server: GET /health answers 200 with the health document
      (spec §9.4 — `status` plus the per-family detail). A TCP connect proves
      nothing; this is what tells our server apart from whatever else took the
      port (review round 1, M2).
    #>
    param(
        [Parameter(Mandatory = $true)][string] $Url,
        [int] $TimeoutSec = 5
    )
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -Method Get
        if ([int]$response.StatusCode -ne 200) { return $false }
        $health = $response.Content | ConvertFrom-Json
        return ($null -ne $health.PSObject.Properties['status'])
    } catch {
        return $false
    }
}

function Test-VLTcpObs {
    <#
      OBS speaks obs-websocket, not HTTP, so its readiness signal is the port —
      but only when the process holding it really is the configured OBS binary.
      Any other listener on 4455 is a foreign process, not a ready encoder (M2).
    #>
    param(
        [Parameter(Mandatory = $true)][int] $Port,
        [Parameter(Mandatory = $true)][string] $ExecutableName
    )
    $owner = Get-VLPortOwner -Port $Port
    if (-not $owner.Found) { return $false }
    if ($null -eq $owner.Name) { return $false }
    return ($owner.Name -eq [System.IO.Path]::GetFileNameWithoutExtension($ExecutableName))
}

function Wait-VLReady {
    <#
      Polls a readiness predicate until it holds or the timeout expires.
      Returns $true/$false; the caller decides what a timeout means.
    #>
    param(
        [Parameter(Mandatory = $true)][scriptblock] $Probe,
        [Parameter(Mandatory = $true)][string] $What,
        [int] $TimeoutSec = 60,
        [int] $IntervalMs = 1000,
        [string] $LogFile
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (& $Probe) {
            Write-VLLog -Message "ready: $What" -LogFile $LogFile
            return $true
        }
        Start-Sleep -Milliseconds $IntervalMs
    }
    Write-VLLog -Message "timed out after ${TimeoutSec}s waiting for: $What" -Level 'error' -LogFile $LogFile
    return $false
}

function Invoke-VLSchtasks {
    <#
      Runs schtasks.exe and returns @{ ExitCode; Output }. Output is returned
      rather than printed so callers can log it as evidence.

      `$ErrorActionPreference` is lowered for the call because Windows PowerShell
      turns a native command's stderr into an ErrorRecord: `schtasks /Query` for a
      task that is not registered writes "ERROR: The system cannot find the file
      specified." and would abort the caller under `Stop`. Here that is not an
      error — it is the answer.
    #>
    param([Parameter(Mandatory = $true)][string[]] $Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # `.ToString()` keeps stderr lines as plain text instead of ErrorRecords,
        # which Windows PowerShell would otherwise render with a stack trace.
        $output = & schtasks.exe @Arguments 2>&1 | ForEach-Object { $_.ToString() }
        return @{ ExitCode = $LASTEXITCODE; Output = ($output | Out-String).TrimEnd() }
    } finally {
        $ErrorActionPreference = $previous
    }
}
