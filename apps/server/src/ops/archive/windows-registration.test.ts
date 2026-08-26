import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const ARCHIVE_XML = resolve(REPOSITORY_ROOT, 'ops/windows/tasks/vertical-live-archive.xml')
const REGISTER_SCRIPT = resolve(REPOSITORY_ROOT, 'ops/windows/Register-VerticalLive.ps1')

describe('archive scheduled-task registration', () => {
  it('defines logon recovery plus a renewed daily hourly calendar schedule', () => {
    const xml = readFileSync(ARCHIVE_XML, 'utf8')
    const logon = xml.match(/<LogonTrigger>[\s\S]*?<\/LogonTrigger>/u)?.[0]
    const calendar = xml.match(/<CalendarTrigger>[\s\S]*?<\/CalendarTrigger>/u)?.[0]

    expect(logon).toContain('<UserId>{{USER_ID}}</UserId>')
    expect(logon).toContain('<Delay>PT5M</Delay>')
    expect(logon).not.toContain('<Repetition>')
    expect(calendar).toContain('<StartBoundary>{{START_BOUNDARY}}</StartBoundary>')
    expect(calendar).toContain('<Interval>{{INTERVAL}}</Interval>')
    expect(calendar).toContain('<Duration>P1D</Duration>')
    expect(calendar).toContain('<StopAtDurationEnd>false</StopAtDurationEnd>')
    expect(calendar).toContain('<ScheduleByDay>')
    expect(calendar).toContain('<DaysInterval>1</DaysInterval>')
  })

  it('keeps interactive ownership, explicit apply, and the repository working directory', () => {
    const xml = readFileSync(ARCHIVE_XML, 'utf8')

    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>')
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>')
    expect(xml).toContain(
      '<Arguments>"{{REPO_ROOT}}\\apps\\server\\dist\\bin\\archive.js" --apply</Arguments>',
    )
    expect(xml).toContain('<WorkingDirectory>{{REPO_ROOT}}</WorkingDirectory>')
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>')
    expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>')
  })

  it('generates and substitutes a future boundary at registration time', () => {
    const script = readFileSync(REGISTER_SCRIPT, 'utf8')

    expect(script).toContain("(Get-Date).AddMinutes(5).ToString('yyyy-MM-ddTHH:mm:ss')")
    expect(script).toContain(".Replace('{{START_BOUNDARY}}', $archiveStartBoundary)")
    expect(script).toContain(".Replace('{{INTERVAL}}', $ArchiveInterval)")
  })

  it.skipIf(process.platform !== 'win32')(
    'renders a custom interval and a boundary five minutes in the future in -WhatIf mode',
    () => {
      const before = Date.now()
      const output = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          REGISTER_SCRIPT,
          '-RepoRoot',
          REPOSITORY_ROOT,
          '-Account',
          'SYNTHETIC\\archive-operator',
          '-NodeExe',
          process.execPath,
          '-ArchiveInterval',
          'PT2H',
          '-WhatIf',
        ],
        { encoding: 'utf8' },
      )
      const boundary = output.match(/<StartBoundary>([^<]+)<\/StartBoundary>/u)?.[1]

      expect(output).toContain('<Interval>PT2H</Interval>')
      expect(output).toContain('<UserId>SYNTHETIC\\archive-operator</UserId>')
      expect(boundary).toBeDefined()
      const boundaryMs = new Date(boundary as string).getTime()
      expect(boundaryMs).toBeGreaterThan(before)
      expect(boundaryMs).toBeLessThanOrEqual(Date.now() + 6 * 60_000)
    },
  )
})
