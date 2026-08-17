<#
.SYNOPSIS
  Removes the vertical-live scheduled tasks (TASK_SPECS §T17).

.DESCRIPTION
  Deletes \VerticalLive\vl-autostart and \VerticalLive\vl-archive-sweep. It does
  not stop anything that is already running: the kill switch does that
  (`npm run kill -w @vl/server`, docs/ops/supervisor.md 2장).

  Dry run: pass -WhatIf.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File ops\windows\Unregister-VerticalLive.ps1 -WhatIf
#>
#Requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string[]] $TaskName = @('\VerticalLive\vl-autostart', '\VerticalLive\vl-archive-sweep')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'VerticalLive.Common.ps1')

foreach ($name in $TaskName) {
    $existing = Invoke-VLSchtasks -Arguments @('/Query', '/TN', $name)
    if ($existing.ExitCode -ne 0) {
        Write-VLLog -Message "not registered: $name" -Level 'warn'
        continue
    }

    Write-VLLog -Message "schtasks.exe /Delete /TN $name /F"
    if ($PSCmdlet.ShouldProcess($name, 'delete scheduled task')) {
        $result = Invoke-VLSchtasks -Arguments @('/Delete', '/TN', $name, '/F')
        Write-VLLog -Message $result.Output
        if ($result.ExitCode -ne 0) {
            throw "schtasks /Delete failed for $name with exit code $($result.ExitCode)"
        }
        # Proof rather than assumption: the task must be gone afterwards.
        $verify = Invoke-VLSchtasks -Arguments @('/Query', '/TN', $name)
        if ($verify.ExitCode -eq 0) { throw "$name still exists after /Delete" }
        Write-VLLog -Message "removed: $name"
    }
}
