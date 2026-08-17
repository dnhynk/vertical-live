/**
 * Redaction for everything that can reach an operator's eyes (spec §10.2:
 * secrets are not exposed in the repository, the DB, logs, or on screen).
 *
 * The rule this module enforces: a secret value is registered once, at the
 * moment it enters the process, and every log line and error string is filtered
 * through the same redactor afterwards. Modules therefore do not have to
 * remember which of their locals happen to be secret.
 */

export type LogValue = string | number | boolean | null | undefined

export interface LogFields {
  readonly [key: string]: LogValue
}

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
}

export const REDACTED = '[redacted]'

/**
 * Values shorter than this are not masked: an 8-character secret cannot be
 * distinguished from ordinary text, and masking e.g. `"1"` everywhere would
 * shred unrelated output. That trade-off was rejected in review round 1: the
 * vault accepts any non-empty value, so a short OBS password or admin token
 * would have stayed visible in an error string. Every non-empty value is masked
 * now, whatever its length — a noisy log is recoverable, a leaked secret is not.
 */

/** Collects secret values and masks them out of arbitrary text. */
export class SecretRedactor {
  readonly #values = new Set<string>()

  /**
   * Registers a value and every encoding of it this process can emit: the raw
   * string, its `encodeURIComponent` form (token requests are form-encoded) and
   * its JSON-escaped form (structured logs).
   *
   * @returns true when the value is now masked, false only when it was empty,
   * `undefined` or `null` — there is nothing to mask in those cases.
   */
  register(value: string | undefined | null): boolean {
    if (value === undefined || value === null || value === '') {
      return false
    }
    for (const encoded of encodings(value)) {
      this.#values.add(encoded)
    }
    return true
  }

  /** Number of distinct encodings currently masked (diagnostics only). */
  get size(): number {
    return this.#values.size
  }

  redact(text: string): string {
    let result = text
    for (const value of this.#values) {
      if (result.includes(value)) {
        result = result.split(value).join(REDACTED)
      }
    }
    return result
  }

  redactFields(fields: LogFields | undefined): LogFields | undefined {
    if (fields === undefined) {
      return undefined
    }
    const out: Record<string, LogValue> = {}
    for (const [key, value] of Object.entries(fields)) {
      out[key] = typeof value === 'string' ? this.redact(value) : value
    }
    return out
  }

  /** Masks an error's message (and stack, when present) for safe logging. */
  redactError(error: unknown): string {
    if (error instanceof Error) {
      return this.redact(error.stack ?? `${error.name}: ${error.message}`)
    }
    return this.redact(String(error))
  }
}

function* encodings(value: string): Generator<string> {
  yield value
  const uriEncoded = encodeURIComponent(value)
  if (uriEncoded !== value) {
    yield uriEncoded
  }
  const jsonEncoded = JSON.stringify(value).slice(1, -1)
  if (jsonEncoded !== value) {
    yield jsonEncoded
  }
}

/** One-shot masking for call sites that do not own a long-lived redactor. */
export function redactValues(text: string, values: Iterable<string | undefined | null>): string {
  const redactor = new SecretRedactor()
  for (const value of values) {
    redactor.register(value)
  }
  return redactor.redact(text)
}

/** Wraps a sink so every message and string field is masked before it lands. */
export function createRedactingLogger(sink: Logger, redactor: SecretRedactor): Logger {
  const forward =
    (level: keyof Logger) =>
    (message: string, fields?: LogFields): void => {
      sink[level](redactor.redact(message), redactor.redactFields(fields))
    }
  return {
    debug: forward('debug'),
    info: forward('info'),
    warn: forward('warn'),
    error: forward('error'),
  }
}

/** Logger that drops everything. Default for libraries that take an optional logger. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
