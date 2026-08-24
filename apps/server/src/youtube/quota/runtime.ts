import type { Clock } from '../../clock.js'
import type { Logger } from '../../secrets/redaction.js'
import type { QuotaConfig } from './config.js'
import { QuotaTracker, type QuotaUsageStore } from './tracker.js'

/** The YouTube integrations that can spend from the process's daily quota. */
export interface YouTubeQuotaPosture {
  readonly chatEnabled: boolean
  readonly broadcastEnabled: boolean
}

export interface ProcessQuotaTrackerOptions extends YouTubeQuotaPosture {
  readonly clock: Clock
  readonly config: QuotaConfig
  readonly store: QuotaUsageStore
  readonly logger?: Logger
}

/**
 * Owns the sole production `QuotaTracker` construction site.
 *
 * Chat and broadcast spend from one Google project allowance. Treating either
 * integration as a separate budget makes the reserve guard smaller than the
 * account-wide spend and lets restarts forget the missing half (T46).
 */
export function createProcessQuotaTracker(
  options: ProcessQuotaTrackerOptions,
): QuotaTracker | null {
  if (!options.chatEnabled && !options.broadcastEnabled) return null
  return new QuotaTracker({
    clock: options.clock,
    dailyUnits: options.config.dailyUnits,
    reserveUnits: options.config.reserveUnits,
    timeZone: options.config.resetTimeZone,
    store: options.store,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
}
