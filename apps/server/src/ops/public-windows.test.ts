import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const START_SCRIPT = resolve(REPOSITORY_ROOT, 'ops/windows/Start-VerticalLive.ps1')
const REGISTER_SCRIPT = resolve(REPOSITORY_ROOT, 'ops/windows/Register-VerticalLive.ps1')

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('Windows public broadcast opt-in', () => {
  it('keeps public validation before environment mutation and forwards exact arguments', () => {
    const start = readFileSync(START_SCRIPT, 'utf8')
    const register = readFileSync(REGISTER_SCRIPT, 'utf8')

    expect(start.indexOf("throw '-Public requires -Broadcast'")).toBeLessThan(
      start.indexOf("$env:VL_OBS_PROCESS_ENABLED = 'true'"),
    )
    expect(
      start.indexOf("throw '-Public and -Unlisted are mutually exclusive privacy modes'"),
    ).toBeLessThan(start.indexOf("$env:VL_OBS_PROCESS_ENABLED = 'true'"))
    expect(start).toContain("elseif ($Public) {\n    $env:VL_YOUTUBE_PRIVACY_STATUS = 'public'\n}")
    expect(count(start, "$env:VL_YOUTUBE_PRIVACY_STATUS = 'public'")).toBe(1)
    expect(register).toContain("if ($Public) { ' -Broadcast -Public' }")
    expect(register).toContain("elseif ($Unlisted) { ' -Unlisted' }")
  })

  it.skipIf(process.platform !== 'win32')(
    'rejects ambiguous public requests before start-up side effects',
    () => {
      for (const args of [['-Public'], ['-Broadcast', '-Public', '-Unlisted']]) {
        const result = spawnSync(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', START_SCRIPT, ...args, '-WhatIf'],
          { encoding: 'utf8' },
        )

        expect(result.status).not.toBe(0)
        expect(`${result.stdout}${result.stderr}`).toMatch(
          /requires -Broadcast|mutually exclusive/u,
        )
        expect(`${result.stdout}${result.stderr}`).not.toContain('starting vertical-live')
      }
    },
  )

  it.skipIf(process.platform !== 'win32')(
    'registers exact public, unlisted, and default start arguments',
    () => {
      const baseArgs = [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        REGISTER_SCRIPT,
        '-RepoRoot',
        REPOSITORY_ROOT,
        '-Account',
        'SYNTHETIC\\pilot-operator',
        '-NodeExe',
        process.execPath,
        '-SkipArchiveTask',
        '-WhatIf',
      ]
      const render = (extra: string[]) =>
        execFileSync('powershell.exe', [...baseArgs, ...extra], { encoding: 'utf8' })

      const publicXml = render(['-Broadcast', '-Public'])
      expect(publicXml).toContain('Start-VerticalLive.ps1" -Broadcast -Public</Arguments>')
      expect(count(publicXml, '-Broadcast -Public')).toBe(1)

      const unlistedXml = render(['-Unlisted'])
      expect(unlistedXml).toContain('Start-VerticalLive.ps1" -Unlisted</Arguments>')
      expect(unlistedXml).not.toContain('-Broadcast -Unlisted')

      const privateXml = render([])
      expect(privateXml).toContain('Start-VerticalLive.ps1"</Arguments>')
      expect(privateXml).not.toContain(' -Public</Arguments>')
      expect(privateXml).not.toContain(' -Unlisted</Arguments>')
    },
  )

  it.skipIf(process.platform !== 'win32')(
    'refuses invalid public registration combinations',
    () => {
      for (const args of [['-Public'], ['-Broadcast', '-Public', '-Unlisted']]) {
        const result = spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            REGISTER_SCRIPT,
            '-RepoRoot',
            REPOSITORY_ROOT,
            ...args,
            '-SkipArchiveTask',
            '-WhatIf',
          ],
          { encoding: 'utf8' },
        )

        expect(result.status).not.toBe(0)
        expect(`${result.stdout}${result.stderr}`).toMatch(
          /requires -Broadcast|mutually exclusive/u,
        )
        expect(`${result.stdout}${result.stderr}`).not.toContain('schtasks.exe')
      }
    },
  )
})
