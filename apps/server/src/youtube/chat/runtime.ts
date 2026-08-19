import type { CommandParser, WorldSnapshot } from '@vl/contract'

import type { Clock } from '../../clock.js'
import type { PersistenceStore } from '../../db/store.js'
import type { InboxWriter } from '../../engine/ingest.js'
import {
  createCommandParserPort,
  parserLimits,
  type CommandMetrics,
  type InputConfig,
} from '../../input/index.js'
import { SecretRedactor, silentLogger, type Logger } from '../../secrets/redaction.js'
import { resolveSecretVault } from '../../secrets/resolve.js'
import { loadOAuthClientCredentials, loadYouTubeAuthConfig } from '../auth/config.js'
import type { AuthEventSink } from '../auth/events.js'
import { OAuthClient } from '../auth/oauth-client.js'
import { TokenManager } from '../auth/token-manager.js'
import { QuotaTracker } from '../quota/tracker.js'
import { loadQuotaConfig } from '../quota/config.js'
import { ChatSource, type LiveChatTargetResolver } from './chat-source.js'
import { loadChatConfig, type ChatConfig } from './config.js'
import type { ConsentFailure, ConsentObserver } from './sink.js'
import type { ChatAccessTokens } from './retry.js'

/**
 * Assembles the chat source the way the server process needs it: T3's OAuth
 * token manager and quota tracker, T6's parser port, T8's inbox and engine gate.
 *
 * It returns `null` when `youtube.chat.enabled` is false, and only then touches
 * no credential at all — a developer running the world locally never needs a
 * Google client id, and a production process fails loudly instead of silently
 * running without chat.
 */

export interface ChatRuntimeDeps {
  readonly store: PersistenceStore
  readonly inbox: InboxWriter
  readonly engine: {
    readonly ready: boolean
    snapshot(): WorldSnapshot
  }
  readonly clock: Clock
  readonly inputConfig: InputConfig
  /**
   * `engine.identityGateOpen` from `config/default.json`, in the consent-mode
   * meaning BOARD D-9 gave it: `false` = closed (A-1), `true` = consenting
   * viewers are recognized. It decides both the requested parts and whether the
   * parser accepts `JOIN`/`LEAVE` at all.
   */
  readonly identityGateOpen: boolean
  /**
   * Consent directory, passed only when the gate is open. Without it the sink
   * has nothing to hand a raw item to, which is the closed behaviour.
   */
  readonly consent?: ConsentObserver
  /** Consent decisions the ingest path could not apply; counted on `/metrics`. */
  readonly onConsentFailure?: (failure: ConsentFailure) => void
  readonly onIngested?: (insertedCount: number) => void
  readonly resolveTarget?: LiveChatTargetResolver
  /**
   * The process's `CommandMetrics` (spec §14.1). It is also the input the
   * `filter_evasion_surge` heuristic reads (§12.3, TASK_SPECS §T22), so the
   * production parser port has to be the one counting — an uncounted parser
   * leaves that detector observing a chat that never says anything.
   */
  readonly commandMetrics?: CommandMetrics
  readonly logger?: Logger
  readonly config?: ChatConfig
  /**
   * Where the `TokenManager` this factory builds sends its auth events. T12
   * needs it for `auth_revoked` → `safe_stopped` (spec §9.1) and T13 for the
   * deletion that revocation triggers (§12.4); neither can reach the manager
   * otherwise, because it is constructed in here. Ignored when `auth` is given —
   * the caller's manager already has its own sink.
   */
  readonly authEvents?: AuthEventSink
  /**
   * An access-token source the process already owns. `main.ts` passes the same
   * `TokenManager` the broadcast lifecycle uses: two managers on one grant would
   * both refresh and rotate the same refresh token (spec §10.2 asks for rotation
   * to be *tested*, not raced).
   */
  readonly auth?: ChatAccessTokens
}

export async function createChatSource(deps: ChatRuntimeDeps): Promise<ChatSource | null> {
  const config = deps.config ?? loadChatConfig({ identityGateOpen: deps.identityGateOpen })
  if (!config.enabled) return null

  const logger = deps.logger ?? silentLogger
  // An injected source is used as-is, and then no credential is touched here at
  // all: the caller's `TokenManager` already owns the grant (see `auth` above).
  const tokens = deps.auth ?? (await buildTokenManager(deps, logger))

  const quotaConfig = loadQuotaConfig()
  const quota = new QuotaTracker({
    clock: deps.clock,
    dailyUnits: quotaConfig.dailyUnits,
    reserveUnits: quotaConfig.reserveUnits,
    timeZone: quotaConfig.resetTimeZone,
  })

  return new ChatSource({
    config,
    clock: deps.clock,
    inbox: deps.inbox,
    checkpoints: deps.store,
    parseCommand: chatParserPort(deps),
    auth: tokens,
    engine: deps.engine,
    quota,
    logger,
    ...(deps.consent === undefined ? {} : { consent: deps.consent }),
    ...(deps.onConsentFailure === undefined ? {} : { onConsentFailure: deps.onConsentFailure }),
    ...(deps.onIngested === undefined ? {} : { onIngested: deps.onIngested }),
    ...(deps.resolveTarget === undefined ? {} : { resolveTarget: deps.resolveTarget }),
  })
}

async function buildTokenManager(deps: ChatRuntimeDeps, logger: Logger): Promise<ChatAccessTokens> {
  const authConfig = loadYouTubeAuthConfig()
  const credentials = loadOAuthClientCredentials()
  const redactor = new SecretRedactor()
  redactor.register(credentials.clientSecret)
  const vault = await resolveSecretVault({ service: authConfig.credentialService, logger })
  return new TokenManager({
    client: new OAuthClient({
      clientId: credentials.clientId,
      ...(credentials.clientSecret === undefined ? {} : { clientSecret: credentials.clientSecret }),
      clock: deps.clock,
    }),
    vault,
    clock: deps.clock,
    refreshSkewMs: authConfig.accessTokenRefreshSkewMs,
    logger,
    redactor,
    ...(deps.authEvents === undefined ? {} : { events: deps.authEvents }),
  })
}

/**
 * The T6 parser, reading the live gate state on every message: a vote alias is
 * only a command while a choice window is open (spec §7.1), and per-user
 * attribution — plus the `JOIN`/`LEAVE` commands themselves — stays off while
 * the consent gate is closed (BOARD A-1, D-9).
 */
export function chatParserPort(deps: {
  readonly engine: { snapshot(): WorldSnapshot }
  readonly inputConfig: InputConfig
  readonly identityGateOpen: boolean
  readonly commandMetrics?: CommandMetrics
}): CommandParser {
  return createCommandParserPort({
    ...(deps.commandMetrics === undefined ? {} : { metrics: deps.commandMetrics }),
    context: () => {
      const snapshot = deps.engine.snapshot()
      const mission = snapshot.mission
      return {
        identityGateOpen: deps.identityGateOpen,
        voteWindowOpen:
          mission !== null && mission.choices.length > 0 && mission.choiceClosesAt !== null,
      }
    },
    limits: parserLimits(deps.inputConfig),
  })
}
