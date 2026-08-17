import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * A real process kill for fault matrix row F-10 (spec §11 "host crash").
 *
 * The child reaches the requested point against the parent's database file and
 * is then `SIGKILL`ed — no shutdown hook, no SQLite close, an open write
 * transaction at the moment it dies. The parent waits for the OS to reap it so
 * the write lock is gone before the restarted engine opens the same file.
 */

const CHILD_SCRIPT = fileURLToPath(new URL('./crash-child.mjs', import.meta.url))
const READY_TIMEOUT_MS = 30_000

export type CrashChildMode = 'uncommitted-delete-then-kill'

export async function crashChild(
  file: string,
  busyTimeoutMs: number,
  mode: CrashChildMode,
): Promise<void> {
  const child = spawn(process.execPath, [CHILD_SCRIPT, file, String(busyTimeoutMs), mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(
        new Error(`crash child did not report ready in ${String(READY_TIMEOUT_MS)}ms: ${stderr}`),
      )
    }, READY_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (!chunk.includes('ready')) return
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve()
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      reject(
        new Error(
          `crash child exited early (code ${String(code)}, signal ${String(signal)}): ${stderr}`,
        ),
      )
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })

  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    child.on('exit', () => {
      resolve()
    })
  })
}
