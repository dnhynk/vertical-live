import type { WorldSnapshot } from '@vl/contract'

import type { Clock } from '../../clock.js'
import type { PersistenceStore } from '../../db/store.js'
import type { InboxWriter } from '../../engine/ingest.js'
import type { CommandMetrics, InputConfig } from '../../input/index.js'
import type { Logger } from '../../secrets/redaction.js'
import type { QuotaTracker } from '../quota/tracker.js'
import type { LiveChatTargetResolver } from './chat-source.js'
import type { ChatConfig } from './config.js'
import type { ChatAccessTokens } from './retry.js'
import type { ChatRuntimeDeps } from './runtime.js'
import type { ConsentFailureKind, ConsentObserver } from './sink.js'

/**
 * The server process's chat wiring, as one function a test can call.
 *
 * `createChatSource` builds the source; this builds the argument `main.ts` gives
 * it. The split exists because that argument is where the T20b consent path was
 * actually broken (review round 2, B1): `main.ts` adapted the engine to the
 * `InboxWriter` port with a two-parameter arrow, which silently dropped the
 * `hooks` third argument — the one carrying `onInserted`. Every consent test
 * passed, because every one of them built its own inbox; nothing exercised the
 * object the process passes. In production the gate was open, `JOIN` stored
 * nothing, `LEAVE` deleted nothing, and the inbox committed as if it had.
 *
 * So the engine is now handed over as the port it already satisfies, with no
 * adapter to drop anything, and `wiring.test.ts` drives a `JOIN` and a `LEAVE`
 * through the object this function returns.
 */

/**
 * What the process's `StateEngine` gives the chat source. Structural on purpose:
 * this module is below the engine, and naming the four members it uses keeps the
 * dependency in one direction.
 */
export interface ChatWiringEngine extends InboxWriter {
  readonly ready: boolean
  snapshot(): WorldSnapshot
  /** Runs a writer pass after a commit; records its own failures. */
  pump(): number
  /** `/metrics` counter for a consent decision the ingest path could not apply. */
  countConsentFailure(kind: ConsentFailureKind): void
}

export interface ChatWiring {
  readonly store: PersistenceStore
  readonly engine: ChatWiringEngine
  readonly clock: Clock
  readonly inputConfig: InputConfig
  /** Counts parses for §14.1 and feeds the §12.3 evasion heuristic (§T22). */
  readonly commandMetrics: CommandMetrics
  readonly identityGateOpen: boolean
  /** The consent directory, or `null` while the gate is closed (BOARD D-9). */
  readonly consent: ConsentObserver | null
  readonly config: ChatConfig
  readonly logger: Logger
  /** The process's shared `TokenManager`, or `null` when there is no grant yet. */
  readonly auth: ChatAccessTokens | null
  /** The process's shared quota tracker, or `null` when YouTube is disabled. */
  readonly quota: QuotaTracker | null
  /** T10's bound broadcast, or `null` when the lifecycle is not wired. */
  readonly resolveTarget: LiveChatTargetResolver | null
}

export function chatRuntimeDeps(wiring: ChatWiring): ChatRuntimeDeps {
  const { engine } = wiring
  return {
    store: wiring.store,
    // The engine itself, not an adapter around it: an adapter is what lost the
    // `hooks` argument, and this cannot lose an argument it never names.
    inbox: engine,
    engine: {
      get ready() {
        return engine.ready
      },
      snapshot: () => engine.snapshot(),
    },
    clock: wiring.clock,
    inputConfig: wiring.inputConfig,
    commandMetrics: wiring.commandMetrics,
    identityGateOpen: wiring.identityGateOpen,
    ...(wiring.consent === null
      ? {}
      : {
          consent: wiring.consent,
          onConsentFailure: (failure) => {
            engine.countConsentFailure(failure.kind)
          },
        }),
    config: wiring.config,
    logger: wiring.logger,
    ...(wiring.auth === null ? {} : { auth: wiring.auth }),
    ...(wiring.quota === null ? {} : { quota: wiring.quota }),
    ...(wiring.resolveTarget === null ? {} : { resolveTarget: wiring.resolveTarget }),
    onIngested: () => {
      engine.pump()
    },
  }
}
