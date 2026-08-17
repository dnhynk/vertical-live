import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import type { CrashChildMode } from './crash-child.js'

/**
 * A real process-boundary crash for the crash rows of spec §11.
 *
 * The child runs the product's own store and engine (`crash-child.ts`), reaches
 * one named commit boundary, parks the thread there and is `SIGKILL`ed with it
 * open. The parent then waits for the OS to reap it, so the write lock is gone
 * before anything reopens the file, and asserts what survived by starting a real
 * supervised system on it.
 *
 * Nothing here is a stand-in: the process that dies is the one that owns the
 * transaction, and killing it is the only reason the state on disk is what it is.
 */

/** Repository root; `src/injection/…` and `dist/injection/…` are both four deep. */
const REPO_ROOT_URL = new URL('../../../../', import.meta.url)

/**
 * The child is always run from `src/`, never from `dist/`.
 *
 * It is a TypeScript program that Node type-strips on the fly, and it has to
 * work during `npm run test` — before `npm run build` has emitted anything.
 */
const CHILD_REGISTER = new URL('tools/soak/src/injection/child-register.mjs', REPO_ROOT_URL).href
const CHILD_SCRIPT = fileURLToPath(
  new URL('tools/soak/src/injection/crash-child.ts', REPO_ROOT_URL),
)
/** Forward slashes, no trailing separator: `child-resolve.mjs` joins onto it. */
const REPO_ROOT = fileURLToPath(REPO_ROOT_URL).replaceAll('\\', '/').replace(/\/$/, '')

const READY_TIMEOUT_MS = 60_000

export interface CrashResult {
  /**
   * What the child reported about itself before it died, when its mode says
   * something the parent cannot otherwise know. `null` for the modes that park
   * inside a call and so can report nothing but `ready`.
   */
  readonly state: { readonly stateRevision: number; readonly processedIngestSeq: number } | null
}

export type { CrashChildMode }

/**
 * Runs the child to `mode`'s boundary and kills it there.
 *
 * Rejects when the child exits on its own: that means it never reached the
 * boundary, and a drill that quietly continued would be asserting recovery from
 * a crash that never happened.
 */
export async function crashChild(file: string, mode: CrashChildMode): Promise<CrashResult> {
  const child = spawn(process.execPath, ['--import', CHILD_REGISTER, CHILD_SCRIPT, file, mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VL_REPO_ROOT: REPO_ROOT },
  })

  let stderr = ''
  let stdout = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(
        new Error(
          `crash child (${mode}) did not report ready in ${String(READY_TIMEOUT_MS)}ms: ${stderr}`,
        ),
      )
    }, READY_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (!stdout.includes('ready\n')) return
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve()
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      reject(
        new Error(
          `crash child (${mode}) exited before the boundary (code ${String(code)}, signal ${String(signal)}): ${stderr || stdout}`,
        ),
      )
    })
    child.on('error', reject)
  })

  // Wait for the OS to reap it, so the write lock is gone before we reopen.
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    child.on('exit', () => {
      resolve()
    })
  })

  return { state: parseState(stdout) }
}

function parseState(stdout: string): CrashResult['state'] {
  const line = stdout.split('\n').find((entry) => entry.startsWith('state '))
  if (line === undefined) return null
  return JSON.parse(line.slice('state '.length)) as NonNullable<CrashResult['state']>
}
