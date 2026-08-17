import type { Clock } from '../../clock.js'
import { silentLogger, type Logger } from '../../secrets/redaction.js'
import type { PlannedMethod } from '../scopes.js'
import {
  QUOTA_DAILY_DEFAULT_UNITS,
  QUOTA_RESET_TIME_ZONE,
  quotaCostOf,
  type QuotaCostEntry,
} from './costs.js'

/**
 * Daily quota accounting. The API gives no usage read-back, so the product
 * counts what it spends and refuses calls that would eat into the reserve —
 * the reserve keeps enough units for the broadcast-recovery calls
 * (`liveBroadcasts.list`/`transition`) that must still work at the end of a
 * heavy day.
 *
 * The counter is in memory here; T4 owns persistence and can restore a snapshot
 * on start so a restart does not forget the day's spend.
 */

export interface QuotaUsageSnapshot {
  /** Quota day in Pacific Time (`YYYY-MM-DD`), the reset boundary Google uses. */
  readonly quotaDay: string
  readonly spentUnits: number
  readonly dailyUnits: number
  readonly reserveUnits: number
  readonly remainingUnits: number
  /** Units spent per method, for `/metrics` and for tuning the reserve. */
  readonly byMethod: Readonly<Partial<Record<PlannedMethod, number>>>
}

export interface QuotaTrackerOptions {
  readonly clock: Clock
  readonly dailyUnits?: number
  /** Units held back from ordinary calls; `record` still counts past it. */
  readonly reserveUnits?: number
  readonly timeZone?: string
  readonly logger?: Logger
}

export class QuotaTracker {
  readonly dailyUnits: number
  readonly reserveUnits: number
  readonly timeZone: string
  readonly #clock: Clock
  readonly #logger: Logger

  #quotaDay: string
  #spentUnits = 0
  #byMethod = new Map<PlannedMethod, number>()

  constructor(options: QuotaTrackerOptions) {
    this.#clock = options.clock
    this.dailyUnits = options.dailyUnits ?? QUOTA_DAILY_DEFAULT_UNITS
    this.reserveUnits = options.reserveUnits ?? 0
    this.timeZone = options.timeZone ?? QUOTA_RESET_TIME_ZONE
    this.#logger = options.logger ?? silentLogger
    if (this.reserveUnits < 0 || this.reserveUnits >= this.dailyUnits) {
      throw new Error('reserveUnits must be between 0 and dailyUnits')
    }
    this.#quotaDay = this.#today()
  }

  /** Books `calls` invocations of `method` and returns the new usage. */
  record(method: PlannedMethod, calls = 1): QuotaUsageSnapshot {
    if (!Number.isInteger(calls) || calls <= 0) {
      throw new Error(`calls must be a positive integer, got ${calls}`)
    }
    this.#rollOverIfNeeded()
    const units = quotaCostOf(method) * calls
    this.#spentUnits += units
    this.#byMethod.set(method, (this.#byMethod.get(method) ?? 0) + units)
    if (this.#spentUnits > this.dailyUnits) {
      this.#logger.warn('daily quota budget exceeded by local accounting', {
        quotaDay: this.#quotaDay,
        spentUnits: this.#spentUnits,
        dailyUnits: this.dailyUnits,
      })
    }
    return this.snapshot()
  }

  /** True when the call fits without touching the reserve. */
  canSpend(method: PlannedMethod, calls = 1): boolean {
    this.#rollOverIfNeeded()
    const units = quotaCostOf(method) * calls
    return this.#spentUnits + units <= this.dailyUnits - this.reserveUnits
  }

  /** True when even the reserve cannot cover the call. */
  isExhausted(method: PlannedMethod, calls = 1): boolean {
    this.#rollOverIfNeeded()
    return this.#spentUnits + quotaCostOf(method) * calls > this.dailyUnits
  }

  snapshot(): QuotaUsageSnapshot {
    this.#rollOverIfNeeded()
    return {
      quotaDay: this.#quotaDay,
      spentUnits: this.#spentUnits,
      dailyUnits: this.dailyUnits,
      reserveUnits: this.reserveUnits,
      remainingUnits: Math.max(0, this.dailyUnits - this.#spentUnits),
      byMethod: Object.fromEntries(this.#byMethod) as Partial<Record<PlannedMethod, number>>,
    }
  }

  /** Restores a persisted snapshot; a snapshot from another quota day is dropped. */
  restore(snapshot: QuotaUsageSnapshot): void {
    const today = this.#today()
    if (snapshot.quotaDay !== today) {
      this.#logger.info('ignoring quota snapshot from a previous quota day', {
        snapshotDay: snapshot.quotaDay,
        quotaDay: today,
      })
      this.#resetTo(today)
      return
    }
    this.#quotaDay = today
    this.#spentUnits = snapshot.spentUnits
    this.#byMethod = new Map(
      Object.entries(snapshot.byMethod).map(([method, units]) => [
        method as PlannedMethod,
        units ?? 0,
      ]),
    )
  }

  /** Absolute UTC instant of the next Pacific-midnight reset. */
  nextResetAt(): string {
    const nowMs = Date.parse(this.#clock.nowUtcIso())
    return new Date(nextMidnightMs(nowMs, this.timeZone)).toISOString()
  }

  msUntilReset(): number {
    const nowMs = Date.parse(this.#clock.nowUtcIso())
    return Math.max(0, nextMidnightMs(nowMs, this.timeZone) - nowMs)
  }

  #today(): string {
    return quotaDayOf(Date.parse(this.#clock.nowUtcIso()), this.timeZone)
  }

  #rollOverIfNeeded(): void {
    const today = this.#today()
    if (today !== this.#quotaDay) {
      this.#logger.info('quota day rolled over', { from: this.#quotaDay, to: today })
      this.#resetTo(today)
    }
  }

  #resetTo(quotaDay: string): void {
    this.#quotaDay = quotaDay
    this.#spentUnits = 0
    this.#byMethod = new Map()
  }
}

/** `YYYY-MM-DD` in the quota time zone. */
export function quotaDayOf(instantMs: number, timeZone = QUOTA_RESET_TIME_ZONE): string {
  const { year, month, day } = zonedParts(instantMs, timeZone)
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
}

/** Instant (ms) of the next midnight in `timeZone` strictly after `instantMs`. */
export function nextMidnightMs(instantMs: number, timeZone = QUOTA_RESET_TIME_ZONE): number {
  const { year, month, day } = zonedParts(instantMs, timeZone)
  const nextWallDayUtc = Date.UTC(year, month - 1, day) + 86_400_000
  // Convert the wall-clock midnight to an instant, then correct once for a DST
  // shift that happens between the two offsets.
  let candidate = nextWallDayUtc + offsetMsAt(instantMs, timeZone)
  candidate = nextWallDayUtc + offsetMsAt(candidate, timeZone)
  return candidate
}

interface ZonedParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function zonedParts(instantMs: number, timeZone: string): ZonedParts {
  let formatter = formatterCache.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatterCache.set(timeZone, formatter)
  }
  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(new Date(instantMs))) {
    parts[part.type] = part.value
  }
  return {
    year: Number(parts['year']),
    month: Number(parts['month']),
    day: Number(parts['day']),
    hour: Number(parts['hour']),
    minute: Number(parts['minute']),
    second: Number(parts['second']),
  }
}

/** UTC offset of `timeZone` at `instantMs`, in ms (negative west of Greenwich). */
function offsetMsAt(instantMs: number, timeZone: string): number {
  const p = zonedParts(instantMs, timeZone)
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return instantMs - asIfUtc
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/** Re-exported for callers that want to describe a cost without the tracker. */
export type { QuotaCostEntry }
