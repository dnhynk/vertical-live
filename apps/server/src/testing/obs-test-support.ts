import type { ObsConfig } from '../obs/config.js'

/**
 * Obviously synthetic password for the fake obs-websocket server (CLAUDE.md §3:
 * no real secret ever reaches the repository, a test, or a fixture).
 */
export const TEST_OBS_PASSWORD = 'test-obs-websocket-password'

/** The same shape `loadObsConfig` produces, with the fake server's URL. */
export function testObsConfig(url: string, overrides: Partial<ObsConfig> = {}): ObsConfig {
  return {
    url,
    connectTimeoutMs: 5000,
    pollIntervalMs: 2000,
    commandVerifyTimeoutMs: 5000,
    commandVerifyIntervalMs: 250,
    browserSourceName: 'test-browser-source',
    reconnect: { initialDelayMs: 1000, maxDelayMs: 30_000, factor: 2 },
    thresholds: {
      congestionDegradedAt: 0.2,
      skippedFrameRatioDegradedAt: 0.01,
      stalledSamplesDegradedAt: 2,
    },
    provisional: [],
    ...overrides,
  }
}

/**
 * Waits on real time for a condition driven by socket I/O. The injected
 * `FakeClock` controls the code under test; this only bounds how long the test
 * waits for the network round trips that clock cannot schedule.
 */
export async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) {
      return
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
