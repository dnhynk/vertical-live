<#
.SYNOPSIS
  Registers the vertical-live logon autostart and archive-sweep scheduled tasks
  (TASK_SPECS §T17, spec §11).

.DESCRIPTION
  Substitutes the host-specific values into ops/windows/tasks/*.xml and registers
  them with schtasks.exe.

  Two tasks are registered:

    \VerticalLive\vl-autostart      at logon, runs Start-VerticalLive.ps1
    \VerticalLive\vl-archive-sweep  after logon and every -ArchiveInterval on a
                                    daily calendar schedule, runs the archive CLI

  Both run **as the logged-on user in an interactive session**
  (`LogonType InteractiveToken`), because OBS composites and encodes on a real
  desktop with a GPU. A task that runs "whether or not the user is logged on"
  lands in session 0, where OBS cannot do that. The consequence — the host needs
  automatic logon and a session that stays unlocked — is the operator checklist
  in docs/ops/windows-host.md.

  Dry run: pass -WhatIf. It prints the exact XML and the exact schtasks command
  and changes nothing.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File ops\windows\Register-VerticalLive.ps1 -WhatIf

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File ops\windows\Register-VerticalLive.ps1
#>
#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $RepoRoot,
    # DOMAIN\user (or COMPUTER\user) the tasks run as. Defaults to the caller.
    [string] $Account,
    [string] $NodeExe,
    # ISO 8601 duration between archive sweeps.
    [string] $ArchiveInterval = 'PT1H',
    # Registers the logon task with -WithObs, so the host starts OBS as part of
    # the sequence. Without it the stack comes up and then safe-stops: the
    # supervisor's renderer-source recovery needs the OBS integration, and no
    # renderer ever attaches (TASK_SPECS §T25).
    [switch] $WithObs,
    # Registers the logon task with -Broadcast: OBS, the broadcast lifecycle and
    # the chat listener, which is what unattended operation needs (TASK_SPECS §T32).
    [switch] $Broadcast,
    # Registers the logon task with -Unlisted (BOARD D-24, Gate 2 calibration).
    [switch] $Unlisted,
    [switch] $SkipArchiveTask
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'VerticalLive.Common.ps1')

if (-not $RepoRoot) { $RepoRoot = Get-VerticalLiveRepoRoot -ScriptRoot $PSScriptRoot }
$RepoRoot = (Resolve-Path $RepoRoot).Path
if (-not (Test-Path (Join-Path $RepoRoot 'config\default.json'))) {
    throw "not a vertical-live checkout: $RepoRoot"
}
if (-not $Account) { $Account = "$env:USERDOMAIN\$env:USERNAME" }
$node = Get-VerticalLiveNodeExe -NodeExe $NodeExe
# A time/calendar trigger requires a StartBoundary. Generate it at registration
# rather than committing a date that eventually becomes stale. The logon trigger
# covers the same five-minute startup window; the calendar trigger supplies an
# observable future NextRunTime and renews its P1D repetition window each day.
$archiveStartBoundary = (Get-Date).AddMinutes(5).ToString('yyyy-MM-ddTHH:mm:ss')

Write-VLLog -Message "repository: $RepoRoot"
Write-VLLog -Message "run-as account: $Account (interactive session required)"
Write-VLLog -Message "node: $node"

$definitions = @(
    @{
        Name     = '\VerticalLive\vl-autostart'
        Template = Join-Path $PSScriptRoot 'tasks\vertical-live-autostart.xml'
    }
)
if (-not $SkipArchiveTask) {
    $definitions += @{
        Name     = '\VerticalLive\vl-archive-sweep'
        Template = Join-Path $PSScriptRoot 'tasks\vertical-live-archive.xml'
    }
}

$temporary = @()
try {
    foreach ($definition in $definitions) {
        $xml = Get-Content -Path $definition.Template -Raw -Encoding UTF8
        $xml = $xml.Replace('{{USER_ID}}', $Account)
        $xml = $xml.Replace('{{REPO_ROOT}}', $RepoRoot)
        $xml = $xml.Replace('{{NODE_EXE}}', $node)
        $xml = $xml.Replace('{{INTERVAL}}', $ArchiveInterval)
        $xml = $xml.Replace('{{START_BOUNDARY}}', $archiveStartBoundary)
        # -Broadcast implies -WithObs, so it is passed alone rather than with a
        # redundant second switch the launcher would have to reconcile.
        $startArgs =
            if ($Unlisted) { ' -Unlisted' }
            elseif ($Broadcast) { ' -Broadcast' }
            elseif ($WithObs) { ' -WithObs' }
            else { '' }
        $xml = $xml.Replace('{{START_ARGS}}', $startArgs)

        # schtasks reads task XML as Unicode; UTF-8 is rejected with
        # "The task XML is malformed" on some Windows builds.
        $file = Join-Path ([System.IO.Path]::GetTempPath()) ("vl-task-" + [System.Guid]::NewGuid().ToString('N') + '.xml')
        Set-Content -Path $file -Value $xml -Encoding Unicode
        $temporary += $file

        $arguments = @('/Create', '/TN', $definition.Name, '/XML', $file, '/F')
        Write-VLLog -Message ("schtasks.exe " + ($arguments -join ' '))

        if ($PSCmdlet.ShouldProcess($definition.Name, 'register scheduled task')) {
            $result = Invoke-VLSchtasks -Arguments $arguments
            Write-VLLog -Message $result.Output
            if ($result.ExitCode -ne 0) {
                throw "schtasks /Create failed for $($definition.Name) with exit code $($result.ExitCode)"
            }
            $query = Invoke-VLSchtasks -Arguments @('/Query', '/TN', $definition.Name, '/V', '/FO', 'LIST')
            Write-VLLog -Message $query.Output
        } else {
            Write-VLLog -Message "--- would register $($definition.Name) with this definition ---"
            Write-Host $xml
        }
    }
} finally {
    foreach ($file in $temporary) {
        if (Test-Path $file) { Remove-Item -Path $file -Force -ErrorAction SilentlyContinue }
    }
}

Write-VLLog -Message 'done. Unregister with ops\windows\Unregister-VerticalLive.ps1'
Write-VLLog -Message 'the host still needs the docs/ops/windows-host.md checklist (automatic logon, sleep, updates) before it runs unattended' -Level 'warn'
