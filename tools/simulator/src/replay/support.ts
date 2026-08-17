/**
 * Small helpers shared by the replay tests. Nothing here re-implements a product
 * rule: the assertions read the real store, the real `/metrics` snapshot and the
 * real published frames.
 */

export function toMillis(instant: string): number {
  return Date.parse(instant)
}

/**
 * Waits for a condition that depends on a WebSocket frame crossing loopback.
 *
 * The engine's clock is virtual, but the socket is real: a published effect
 * reaches the stub renderer after a few turns of the event loop, not inside
 * `pump()`. This polls in real milliseconds — a bounded few, not a sleep — and
 * returns whether the condition held, so the caller's assertion is what reports
 * the failure.
 */
export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1)
    })
  }
}

/** Lets any frame already in flight arrive, for asserting that none does. */
export async function settle(millis = 100): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, millis)
  })
}

/** Deep scan of any published payload for a substring (spec §12.3 leak check). */
export function containsAnywhere(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle)
  if (Array.isArray(value)) return value.some((entry) => containsAnywhere(entry, needle))
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(
      ([key, entry]) => key.includes(needle) || containsAnywhere(entry, needle),
    )
  }
  return false
}
