import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { systemClock, type Clock, type TimerHandle } from '../clock.js'
import { silentLogger, type Logger } from '../secrets/redaction.js'
import { authorizeAdmin, readTokenField, type AdminRequest, type AdminResponse } from './admin-auth.js'
import type { KillSwitchConfig } from './config.js'

/**
 * Emergency stop (spec §9.1 "최초 공개 및 비상 중지 권한 보유", §11 안전 정지).
 *
 * Three independent paths, because each one fails differently:
 *
 * 1. `POST /admin/kill` — loopback **and** bearer `server.adminToken` (spec
 *    §10.2). Fast, but useless if the HTTP loop is wedged.
 * 2. A local **flag file** — polled, so it works even when nothing in the
 *    process is answering requests, and it survives a restart: a run that comes
 *    back up with the flag still on the disk stops again instead of quietly
 *    resuming. Clearing it is the operator's explicit act.
 * 3. The **CLI** (`apps/server/src/bin/kill.ts`) — what a human actually types.
 *    It tries HTTP first and falls back to the flag file, so one wedged path
 *    does not take the operator's ability to stop the broadcast with it.
 *
 * All three end in the same place: `Supervisor.requestSafeStop({kind:
 * 'kill_switch'})`, which does not restart automatically (§9.2).
 */

export interface KillSwitchRequest {
  readonly source: 'http' | 'file' | 'cli'
  /** Operator-supplied, machine-stable; defaults per path. */
  readonly reason: string
  readonly at: string
}

export type KillSwitchHandler = (request: KillSwitchRequest) => void

export type AdminKillRequest = AdminRequest
export type AdminKillResponse = AdminResponse

export interface AdminKillEndpointOptions {
  /** `server.adminToken` from the vault. `null` closes the door (spec §10.2). */
  readonly token: string | null
  readonly onKill: KillSwitchHandler
  readonly clock?: Clock
}

/** Path 1: `POST /admin/kill`, loopback + bearer token. */
export class AdminKillEndpoint {
  readonly #options: AdminKillEndpointOptions
  readonly #clock: Clock

  constructor(options: AdminKillEndpointOptions) {
    this.#options = options
    this.#clock = options.clock ?? systemClock
  }

  handle(request: AdminKillRequest): AdminKillResponse {
    const refusal = authorizeAdmin(request, this.#options.token)
    if (refusal !== null) return refusal
    // Operator text is not echoed into the world: only a bounded, printable
    // token reaches the alert and `/health`.
    const reason = readTokenField(request.body, 'reason') ?? 'admin_http'
    const at = this.#clock.nowUtcIso()
    this.#options.onKill({ source: 'http', reason, at })
    return { status: 202, body: { accepted: true, source: 'http', reason, at } }
  }
}

export interface KillSwitchFileOptions {
  readonly config: KillSwitchConfig
  readonly onKill: KillSwitchHandler
  readonly clock?: Clock
  readonly logger?: Logger
  /** Injected in tests; defaults to the real file system. */
  readonly fs?: KillSwitchFs
}

/** The few file operations this needs, so tests do not touch a real disk. */
export interface KillSwitchFs {
  exists(path: string): boolean
  read(path: string): string
  write(path: string, contents: string): void
  remove(path: string): void
}

export const nodeKillSwitchFs: KillSwitchFs = {
  exists: (path) => existsSync(path),
  read: (path) => readFileSync(path, 'utf8'),
  write: (path, contents) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents, 'utf8')
  },
  remove: (path) => {
    rmSync(path, { force: true })
  },
}

/**
 * Path 2: the flag file. Checked once on start (`checkNow()`) so a flag left
 * from the previous run is honoured before anything goes live, then polled.
 */
export class KillSwitchFileWatcher {
  readonly #options: KillSwitchFileOptions
  readonly #fs: KillSwitchFs
  readonly #clock: Clock
  readonly #logger: Logger

  #running = false
  #timer: TimerHandle | undefined
  #fired = false

  constructor(options: KillSwitchFileOptions) {
    this.#options = options
    this.#fs = options.fs ?? nodeKillSwitchFs
    this.#clock = options.clock ?? systemClock
    this.#logger = options.logger ?? silentLogger
  }

  get running(): boolean {
    return this.#running
  }

  get path(): string {
    return this.#options.config.flagFile
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.checkNow()
    this.#scheduleNext()
  }

  stop(): void {
    if (!this.#running) return
    this.#running = false
    if (this.#timer !== undefined) {
      this.#clock.clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }

  /** True when the flag was present. Fires the handler exactly once per flag. */
  checkNow(): boolean {
    let present: boolean
    try {
      present = this.#fs.exists(this.path)
    } catch (error) {
      this.#logger.warn('kill switch flag unreadable', {
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
    if (!present) {
      // Removing the flag re-arms the watcher, but it never restarts the run:
      // `safe_stopped` is left by starting the process again (spec §9.2).
      this.#fired = false
      return false
    }
    if (this.#fired) return true
    this.#fired = true
    this.#options.onKill({
      source: 'file',
      reason: this.#readReason(),
      at: this.#clock.nowUtcIso(),
    })
    return true
  }

  #readReason(): string {
    try {
      const contents = this.#fs.read(this.path).trim()
      const reason = readTokenField({ reason: contents }, 'reason')
      return reason ?? 'kill_switch_file'
    } catch {
      return 'kill_switch_file'
    }
  }

  #scheduleNext(): void {
    if (!this.#running) return
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined
      this.checkNow()
      this.#scheduleNext()
    }, this.#options.config.pollIntervalMs)
  }
}

/** Writes the flag file — used by the CLI and by an operator's own script. */
export function writeKillSwitchFlag(
  config: KillSwitchConfig,
  reason: string,
  at: string,
  fs: KillSwitchFs = nodeKillSwitchFs,
): void {
  fs.write(config.flagFile, `${reason}\n# written ${at}\n`)
}

export function clearKillSwitchFlag(
  config: KillSwitchConfig,
  fs: KillSwitchFs = nodeKillSwitchFs,
): void {
  fs.remove(config.flagFile)
}
