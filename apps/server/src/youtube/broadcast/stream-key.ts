import { SecretRedactor, silentLogger, type Logger } from '../../secrets/redaction.js'
import type { SecretVault } from '../../secrets/vault.js'
import type { StreamKeySink } from './api.js'

/**
 * Custody of `cdn.ingestionInfo.streamName` — YouTube's name for the stream key
 * (https://developers.google.com/youtube/v3/live/docs/liveStreams, checked
 * 2026-08-17).
 *
 * The vault is the key's system of record (spec §10.2, BOARD A-16): T2 reads it
 * back and pushes it into OBS with `SetStreamServiceSettings`, so the operator never
 * types it anywhere. This class is the *only* place a key value is held, and it
 * holds one for as long as one API response takes to process:
 *
 * - `liveStreams.list?part=cdn` returns a key for **every** stream on the channel,
 *   not only ours, so keys are staged per stream id and only the id the lifecycle
 *   actually selected is written to the vault. Writing whatever arrived last would
 *   put an unrelated stream's key where OBS reads ours.
 * - every staged value is registered with the shared `SecretRedactor` first, so
 *   from that moment on no log line or error string can carry it;
 * - `commit` clears the staging map, including the keys that were not selected.
 *
 * Nothing here returns a key to a caller, and no method takes one from outside.
 */
export class StreamKeyCustodian {
  readonly #vault: SecretVault
  readonly #redactor: SecretRedactor
  readonly #logger: Logger
  readonly #staged = new Map<string, string>()

  constructor(options: {
    readonly vault: SecretVault
    readonly redactor?: SecretRedactor
    readonly logger?: Logger
  }) {
    this.#vault = options.vault
    this.#redactor = options.redactor ?? new SecretRedactor()
    this.#logger = options.logger ?? silentLogger
  }

  /** Pass this to `YouTubeLiveApi`; it never sees the vault. */
  readonly sink: StreamKeySink = async (streamId, streamKey) => {
    this.#redactor.register(streamKey)
    this.#staged.set(streamId, streamKey)
    return Promise.resolve()
  }

  /** Stream ids a key has been staged for (diagnostics; never the values). */
  get stagedStreamIds(): string[] {
    return [...this.#staged.keys()]
  }

  /**
   * Writes the selected stream's key to the vault and forgets every staged value.
   *
   * @param required true when the key must exist — a stream this process just
   * created is unusable without it, so failing loudly beats a broadcast that binds
   * to a stream OBS cannot push to. On a reused stream it is false: the vault may
   * already hold the same key from an earlier run.
   * @returns true when the vault was written.
   */
  async commit(streamId: string, options: { readonly required: boolean }): Promise<boolean> {
    const staged = this.#staged.get(streamId)
    this.#staged.clear()

    if (staged === undefined) {
      if (options.required) {
        throw new Error(
          `liveStream ${streamId} was created without an ingestion stream key in the response; OBS cannot be configured (spec §10.2)`,
        )
      }
      this.#logger.warn('no stream key in this response; keeping the vault value', { streamId })
      return false
    }

    const current = await this.#vault.get('youtube.streamKey')
    if (current === staged) {
      // Unchanged: skip the write so the OS credential store is not touched on
      // every start, and so the operator's audit log stays meaningful.
      return false
    }
    await this.#vault.set('youtube.streamKey', staged)
    this.#logger.info('stream key stored in the vault', { streamId, rotated: current !== undefined })
    return true
  }

  /** Drops every staged value without writing anything. */
  discard(): void {
    this.#staged.clear()
  }
}
