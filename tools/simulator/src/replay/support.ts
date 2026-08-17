/**
 * Small helpers shared by the replay tests. Nothing here re-implements a product
 * rule: the assertions read the real store, the real `/metrics` snapshot and the
 * real published frames.
 */

export function toMillis(instant: string): number {
  return Date.parse(instant)
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
