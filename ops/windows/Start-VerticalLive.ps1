<#
.SYNOPSIS
  Starts the vertical-live stack in order and waits for each part to be ready
  (TASK_SPECS §T17: 서버, 렌더러 정적 서빙, OBS, 순서와 준비 대기).

.DESCRIPTION
  The order and the reason for it:

    1. renderer static serving (loopback :5173) — OBS's Browser Source has to
       find a page when it loads; starting OBS first means a blank source that
       only recovers on a refresh.
    2. server (loopback :8787) — the renderer connects to /ws/renderer as soon
       as the page loads, and the server must be listening. It also has to be up
       before OBS so that the supervisor's start-up sequence can inject the
       renderer token and the stream key into OBS (BOARD A-16).
    3. OBS — last, through the launcher in @vl/server so the profile, the scene
       collection and the launch parameters have one definition.

  Two rules make the sequence trustworthy (review round 1, M1/M2):

  - **Configuration comes from the server's own loaders**, not from a second
    reader of config/default.json, so `VL_PORT`, `VL_RENDERER_STATIC_PORT/_HOST`,
    `VL_OBS_URL` and `VL_OBS_PROCESS_ENABLED` mean here exactly what they mean
    to the processes being started.
  - **Readiness is a protocol answer, never an open port.** The renderer must
    serve 200 and the server must answer /health with its health document. A
    port that is already open is only accepted when its owning process belongs
    to *this* repository — otherwise the step fails loudly instead of quietly
    adopting another worktree's stack or an unrelated listener.

  What it does NOT do: build, install dependencies, or touch a secret. A logon is
  the wrong moment to compile, and every credential lives in the vault (T3).

  Dry run: pass -WhatIf. It prints the resolved configuration and what it would
  start, and skips the waits.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File ops\windows\Start-VerticalLive.ps1 -WhatIf
#>
#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $RepoRoot,
    [string] $NodeExe,
    [switch] $SkipObs,
    [int] $RendererTimeoutSec = 60,
    [int] $ServerTimeoutSec = 120,
    [int] $ObsTimeoutSec = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'VerticalLive.Common.ps1')

if (-not $RepoRoot) { $RepoRoot = Get-VerticalLiveRepoRoot -ScriptRoot $PSScriptRoot }
$RepoRoot = (Resolve-Path $RepoRoot).Path
$node = Get-VerticalLiveNodeExe -NodeExe $NodeExe

$logDirectory = Join-Path $RepoRoot 'data\ops\logs'
$logFile = Join-Path $logDirectory ('autostart-{0}.log' -f (Get-Date).ToUniversalTime().ToString('yyyyMMdd'))
if (-not (Test-Path $logDirectory) -and -not $WhatIfPreference) {
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
}

Write-VLLog -Message "starting vertical-live from $RepoRoot" -LogFile $logFile
Write-VLLog -Message "session: user=$env:USERNAME interactive=$([System.Environment]::UserInteractive) node=$node" -LogFile $logFile

# The stack runs from built output. Building at logon would make the start time
# depend on a compiler and hide a broken build behind a slow boot.
$serverEntry = Join-Path $RepoRoot 'apps\server\dist\main.js'
$rendererEntry = Join-Path $RepoRoot 'apps\server\dist\bin\serve-renderer.js'
$artifacts = @(
    $serverEntry,
    $rendererEntry,
    (Join-Path $RepoRoot 'apps\server\dist\bin\ops-config.js'),
    (Join-Path $RepoRoot 'apps\server\dist\bin\obs-launch.js'),
    (Join-Path $RepoRoot 'apps\renderer\dist\index.html')
)
$missing = @($artifacts | Where-Object { -not (Test-Path $_) })
if ($missing.Count -gt 0) {
    foreach ($path in $missing) { Write-VLLog -Message "missing build artifact: $path" -Level 'error' -LogFile $logFile }
    Write-VLLog -Message 'run "npm run build" in the repository first' -Level 'error' -LogFile $logFile
    exit 1
}

# One resolved view, from the server's loaders, environment included (M1).
$ops = Get-VerticalLiveOpsConfig -RepoRoot $RepoRoot -NodeExe $node
if ((Resolve-Path $ops.repoRoot).Path -ne $RepoRoot) {
    Write-VLLog -Message "ops config came from $($ops.repoRoot) but this script runs $RepoRoot" -Level 'error' -LogFile $logFile
    exit 1
}
Write-VLLog -Message ("resolved config: renderer=$($ops.renderer.url) server=$($ops.server.healthUrl) obs=$($ops.obs.websocketUrl) obsProcessEnabled=$($ops.obs.processEnabled)") -LogFile $logFile

function Start-VLProcess {
    param(
        [Parameter(Mandatory = $true)][string] $Name,
        [Parameter(Mandatory = $true)][string] $FilePath,
        [Parameter(Mandatory = $true)][string[]] $ArgumentList
    )
    $stdout = Join-Path $logDirectory ("{0}-{1}.log" -f $Name, (Get-Date).ToUniversalTime().ToString('yyyyMMdd'))
    $stderr = Join-Path $logDirectory ("{0}-{1}.err.log" -f $Name, (Get-Date).ToUniversalTime().ToString('yyyyMMdd'))
    Write-VLLog -Message ("start {0}: {1} {2}" -f $Name, $FilePath, ($ArgumentList -join ' ')) -LogFile $logFile
    Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $RepoRoot `
        -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
}

function Test-VLOwnedByThisRepo {
    <#
      True when the process holding a port was started from this checkout. An
      unreadable command line answers false: unknown is not ours (M2).
    #>
    param([Parameter(Mandatory = $true)] $Owner)
    if ($null -eq $Owner.CommandLine) { return $false }
    return ($Owner.CommandLine -like "*$RepoRoot*")
}

function Start-VLComponent {
    <#
      Starts one component, or adopts it when this repository's own process is
      already serving it. Returns $true when the component is ready.
    #>
    param(
        [Parameter(Mandatory = $true)][string] $Name,
        [Parameter(Mandatory = $true)][int] $Port,
        [Parameter(Mandatory = $true)][string] $What,
        [Parameter(Mandatory = $true)][scriptblock] $Probe,
        [Parameter(Mandatory = $true)][scriptblock] $Start,
        [Parameter(Mandatory = $true)][int] $TimeoutSec
    )

    $owner = Get-VLPortOwner -Port $Port
    if ($owner.Found) {
        $ready = & $Probe
        $ours = Test-VLOwnedByThisRepo -Owner $owner
        if ($ready -and $ours) {
            Write-VLLog -Message ("{0} already running and ready (pid {1}, {2})" -f $Name, $owner.ProcessId, $What) -LogFile $logFile
            return $true
        }
        if ($ready) {
            # Answering the probe is not enough: another worktree on this host
            # answers it too, and adopting it would point OBS at someone else's
            # renderer and this script's supervisor at someone else's server.
            Write-VLLog -Message ("{0}: port {1} answers but belongs to pid {2} ({3}) outside {4}; refusing to adopt it" -f $Name, $Port, $owner.ProcessId, $owner.Name, $RepoRoot) -Level 'error' -LogFile $logFile
            return $false
        }
        Write-VLLog -Message ("{0}: port {1} is held by pid {2} ({3}) and does not answer {4}" -f $Name, $Port, $owner.ProcessId, $owner.Name, $What) -Level 'error' -LogFile $logFile
        return $false
    }

    if ($WhatIfPreference) {
        Write-VLLog -Message ("What if: would start {0} and wait for {1}" -f $Name, $What)
        return $true
    }
    & $Start
    return (Wait-VLReady -Probe $Probe -What $What -TimeoutSec $TimeoutSec -LogFile $logFile)
}

$failures = @()

# --- 1. renderer static serving ------------------------------------------------
$rendererUrl = $ops.renderer.url
if (-not (Start-VLComponent -Name 'renderer-static' -Port $ops.renderer.port -What "$rendererUrl (HTTP 200)" `
            -Probe { Test-VLHttpOk -Url $rendererUrl } `
            -Start { Start-VLProcess -Name 'renderer-static' -FilePath $node -ArgumentList @($rendererEntry) } `
            -TimeoutSec $RendererTimeoutSec)) {
    $failures += 'renderer-static'
}

# --- 2. server -----------------------------------------------------------------
$healthUrl = $ops.server.healthUrl
if (-not (Start-VLComponent -Name 'server' -Port $ops.server.port -What "$healthUrl (health document)" `
            -Probe { Test-VLServerHealth -Url $healthUrl } `
            -Start { Start-VLProcess -Name 'server' -FilePath $node -ArgumentList @($serverEntry) } `
            -TimeoutSec $ServerTimeoutSec)) {
    $failures += 'server'
}

# --- 3. OBS --------------------------------------------------------------------
# OBS speaks obs-websocket, not HTTP, so its readiness is the port — but the port
# is only accepted when the process holding it is the configured OBS binary.
$obsPort = [int]$ops.obs.websocketPort
if ($SkipObs) {
    Write-VLLog -Message 'skipping OBS (-SkipObs)' -LogFile $logFile
} elseif (-not $ops.obs.processEnabled) {
    # Honest rather than convenient: with the launcher off, the operator starts
    # OBS. Saying so is better than a silent step (spec §9.1 자동화 경계).
    Write-VLLog -Message 'obs.process.enabled is false: not starting OBS. Start it by hand, set VL_OBS_PROCESS_ENABLED=true, or enable the launcher in config/default.json' -Level 'warn' -LogFile $logFile
} else {
    $obsOwner = Get-VLPortOwner -Port $obsPort
    $obsExecutable = $ops.obs.executableName
    if ($obsOwner.Found) {
        if (Test-VLTcpObs -Port $obsPort -ExecutableName $obsExecutable) {
            Write-VLLog -Message ("obs-websocket already listening on port {0} (pid {1}, {2})" -f $obsPort, $obsOwner.ProcessId, $obsOwner.Name) -LogFile $logFile
        } else {
            Write-VLLog -Message ("obs: port {0} is held by pid {1} ({2}), not {3}" -f $obsPort, $obsOwner.ProcessId, $obsOwner.Name, $obsExecutable) -Level 'error' -LogFile $logFile
            $failures += 'obs-websocket'
        }
    } elseif ($WhatIfPreference) {
        Write-VLLog -Message ("What if: would launch OBS and wait for obs-websocket :{0} owned by {1}" -f $obsPort, $obsExecutable)
    } else {
        $launch = & $node (Join-Path $RepoRoot 'apps\server\dist\bin\obs-launch.js')
        Write-VLLog -Message (($launch | Out-String).TrimEnd()) -LogFile $logFile
        if ($LASTEXITCODE -ne 0) {
            $failures += 'obs-launch'
        } elseif (-not (Wait-VLReady -Probe { Test-VLTcpObs -Port $obsPort -ExecutableName $obsExecutable } -What "obs-websocket :$obsPort ($obsExecutable)" -TimeoutSec $ObsTimeoutSec -LogFile $logFile)) {
            # The port stays closed when the WebSocket server is switched off in
            # the OBS UI (docs/ops/obs-setup.md §2) or when OBS came up in Safe
            # Mode, which disables obs-websocket entirely.
            $failures += 'obs-websocket'
        }
    }
}

if ($failures.Count -gt 0) {
    Write-VLLog -Message ("start sequence incomplete: " + ($failures -join ', ')) -Level 'error' -LogFile $logFile
    exit 1
}

Write-VLLog -Message 'start sequence complete; the supervisor owns the run from here (docs/ops/supervisor.md)' -LogFile $logFile
