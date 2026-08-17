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

  Each step waits for a readiness signal (an HTTP answer, an open port) rather
  than a fixed sleep, and each step is skipped when that signal is already there,
  so running this twice does not start a second stack.

  What it does NOT do: build, install dependencies, or touch a secret. A logon is
  the wrong moment to compile, and every credential lives in the vault (T3).

  Dry run: pass -WhatIf. It prints what it would start and skips the waits.

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
$config = Get-VerticalLiveConfig -RepoRoot $RepoRoot
$node = Get-VerticalLiveNodeExe -NodeExe $NodeExe

$logDirectory = Join-Path $RepoRoot 'data\ops\logs'
$logFile = Join-Path $logDirectory ('autostart-{0}.log' -f (Get-Date).ToUniversalTime().ToString('yyyyMMdd'))
if (-not (Test-Path $logDirectory) -and -not $WhatIfPreference) {
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
}

$serverPort = 8787
if ($env:VL_PORT) { $serverPort = [int]$env:VL_PORT }
$rendererPort = [int]$config.renderer.port
$rendererHost = [string]$config.renderer.host
$obsPort = Get-VerticalLiveObsPort -Config $config

Write-VLLog -Message "starting vertical-live from $RepoRoot" -LogFile $logFile
Write-VLLog -Message "session: user=$env:USERNAME interactive=$([System.Environment]::UserInteractive) node=$node" -LogFile $logFile

# The stack runs from built output. Building at logon would make the start time
# depend on a compiler and hide a broken build behind a slow boot.
$artifacts = @(
    (Join-Path $RepoRoot 'apps\server\dist\main.js'),
    (Join-Path $RepoRoot 'apps\server\dist\bin\serve-renderer.js'),
    (Join-Path $RepoRoot 'apps\renderer\dist\index.html')
)
$missing = @($artifacts | Where-Object { -not (Test-Path $_) })
if ($missing.Count -gt 0) {
    foreach ($path in $missing) { Write-VLLog -Message "missing build artifact: $path" -Level 'error' -LogFile $logFile }
    Write-VLLog -Message 'run "npm run build" in the repository first' -Level 'error' -LogFile $logFile
    exit 1
}

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

$failures = @()

# --- 1. renderer static serving ------------------------------------------------
$rendererUrl = "http://${rendererHost}:${rendererPort}/"
if (Test-VLTcpOpen -ComputerName $rendererHost -Port $rendererPort) {
    Write-VLLog -Message "renderer static serving already listening on $rendererUrl" -LogFile $logFile
} elseif ($PSCmdlet.ShouldProcess($rendererUrl, 'start renderer static serving')) {
    Start-VLProcess -Name 'renderer-static' -FilePath $node -ArgumentList @((Join-Path $RepoRoot 'apps\server\dist\bin\serve-renderer.js'))
    if (-not (Wait-VLReady -Probe { Test-VLHttpAnswers -Url $rendererUrl } -What $rendererUrl -TimeoutSec $RendererTimeoutSec -LogFile $logFile)) {
        $failures += 'renderer-static'
    }
}

# --- 2. server -----------------------------------------------------------------
$healthUrl = "http://127.0.0.1:${serverPort}/health"
if (Test-VLTcpOpen -ComputerName '127.0.0.1' -Port $serverPort) {
    Write-VLLog -Message "server already listening on port $serverPort" -LogFile $logFile
} elseif ($PSCmdlet.ShouldProcess($healthUrl, 'start @vl/server')) {
    Start-VLProcess -Name 'server' -FilePath $node -ArgumentList @((Join-Path $RepoRoot 'apps\server\dist\main.js'))
    if (-not (Wait-VLReady -Probe { Test-VLHttpAnswers -Url $healthUrl } -What $healthUrl -TimeoutSec $ServerTimeoutSec -LogFile $logFile)) {
        $failures += 'server'
    }
}

# --- 3. OBS --------------------------------------------------------------------
if ($SkipObs) {
    Write-VLLog -Message 'skipping OBS (-SkipObs)' -LogFile $logFile
} elseif (-not $config.obs.process.enabled) {
    # Honest rather than convenient: with the launcher off, the operator starts
    # OBS. Saying so is better than a silent step (spec §9.1 자동화 경계).
    Write-VLLog -Message 'obs.process.enabled is false: not starting OBS. Start it by hand or enable the launcher in config/default.json' -Level 'warn' -LogFile $logFile
} elseif (Test-VLTcpOpen -ComputerName '127.0.0.1' -Port $obsPort) {
    Write-VLLog -Message "obs-websocket already listening on port $obsPort" -LogFile $logFile
} elseif ($PSCmdlet.ShouldProcess("obs-websocket :$obsPort", 'launch OBS')) {
    $launch = & $node (Join-Path $RepoRoot 'apps\server\dist\bin\obs-launch.js')
    Write-VLLog -Message (($launch | Out-String).TrimEnd()) -LogFile $logFile
    if ($LASTEXITCODE -ne 0) {
        $failures += 'obs-launch'
    } elseif (-not (Wait-VLReady -Probe { Test-VLTcpOpen -ComputerName '127.0.0.1' -Port $obsPort } -What "obs-websocket :$obsPort" -TimeoutSec $ObsTimeoutSec -LogFile $logFile)) {
        # The port stays closed when the WebSocket server is switched off in the
        # OBS UI (docs/ops/obs-setup.md §2) or when OBS came up in Safe Mode,
        # which disables obs-websocket entirely.
        $failures += 'obs-websocket'
    }
}

if ($failures.Count -gt 0) {
    Write-VLLog -Message ("start sequence incomplete: " + ($failures -join ', ')) -Level 'error' -LogFile $logFile
    exit 1
}

Write-VLLog -Message 'start sequence complete; the supervisor owns the run from here (docs/ops/supervisor.md)' -LogFile $logFile
