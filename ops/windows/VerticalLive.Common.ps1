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

function Get-VerticalLiveConfig {
    <#
      Reads config/default.json. The ops scripts take the ports and paths from
      the same file the server reads, so a changed port cannot leave the
      autostart waiting on the old one.
    #>
    param([Parameter(Mandatory = $true)][string] $RepoRoot)
    $path = Join-Path $RepoRoot 'config\default.json'
    if (-not (Test-Path $path)) { throw "config not found: $path" }
    return (Get-Content -Path $path -Raw -Encoding UTF8 | ConvertFrom-Json)
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

function Get-VerticalLiveObsPort {
    param([Parameter(Mandatory = $true)] $Config)
    # obs.url is a ws:// URL on loopback (spec §10.2); the readiness probe only
    # needs its port.
    $uri = [System.Uri]$Config.obs.url
    return $uri.Port
}

function Test-VLTcpOpen {
    param(
        [Parameter(Mandatory = $true)][string] $ComputerName,
        [Parameter(Mandatory = $true)][int] $Port,
        [int] $TimeoutMs = 1000
    )
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($ComputerName, $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Test-VLHttpAnswers {
    <#
      Readiness means "the listener answered", not "it answered 200":
      GET /health reports `safe_stopped` with a non-2xx status, and that is a
      started server (spec §9.2), not a failed start.
    #>
    param(
        [Parameter(Mandatory = $true)][string] $Url,
        [int] $TimeoutSec = 5
    )
    try {
        Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -Method Get | Out-Null
        return $true
    } catch [System.Net.WebException] {
        $response = $_.Exception.Response
        if ($null -ne $response) { return $true }
        return $false
    } catch {
        return $false
    }
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
        $output = & schtasks.exe @Arguments 2>&1
        return @{ ExitCode = $LASTEXITCODE; Output = ($output | Out-String).TrimEnd() }
    } finally {
        $ErrorActionPreference = $previous
    }
}
