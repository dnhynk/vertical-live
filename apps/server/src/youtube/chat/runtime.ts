import type { CommandParser, WorldSnapshot } from '@vl/contract'

import type { Clock } from '../../clock.js'
import type { PersistenceStore } from '../../db/store.js'
import type { InboxWriter } from '../../engine/ingest.js'
import { createCommandParserPort, parserLimits, type InputConfig } from '../../input/index.js'
import { SecretRedactor, silentLogger, type Logger } from '../../secrets/redaction.js'
import { resolveSecretVault } from '../../secrets/resolve.js'
import { loadOAuthClientCredentials, loadYouTubeAuthConfig } from '../auth/config.js'
import { OAuthClient } from '../auth/oauth-client.js'
import { TokenManager } from '../auth/token-manager.js'
import { QuotaTracker } from '../quota/tracker.js'
import { loadQuotaConfig } from '../quota/config.js'
import { ChatSource, type LiveChatTargetResolver } from './chat-source.js'
import { loadChatConfig, type ChatConfig } from './config.js'

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
  /** `engine.identityGateOpen` from `config/default.json` (BOARD A-1). */
  readonly identityGateOpen: boolean
  readonly onIngested?: (insertedCount: number) => void
  readonly resolveTarget?: LiveChatTargetResolver
  readonly logger?: Logger
  readonly config?: ChatConfig
}

export async function createChatSource(deps: ChatRuntimeDeps): Promise<ChatSource | null> {
  const config = deps.config ?? loadChatConfig()
  if (!config.enabled) return null

  const logger = deps.logger ?? silentLogger
  const authConfig = loadYouTubeAuthConfig()
  const credentials = loadOAuthClientCredentials()
  const redactor = new SecretRedactor()
  redactor.register(credentials.clientSecret)
  const vault = await resolveSecretVault({ service: authConfig.credentialService, logger })
  const tokens = new TokenManager({
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
  })

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
    ...(deps.onIngested === undefined ? {} : { onIngested: deps.onIngested }),
    ...(deps.resolveTarget === undefined ? {} : { resolveTarget: deps.resolveTarget }),
  })
}

/**
 * The T6 parser, reading the live gate state on every message: a vote alias is
 * only a command while a choice window is open (spec §7.1), and per-user
 * attribution stays off while the identity gate is closed (BOARD A-1).
 */
export function chatParserPort(deps: {
  readonly engine: { snapshot(): WorldSnapshot }
  readonly inputConfig: InputConfig
  readonly identityGateOpen: boolean
}): CommandParser {
  return createCommandParserPort({
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
