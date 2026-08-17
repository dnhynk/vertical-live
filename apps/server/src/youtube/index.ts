export {
  METHOD_SCOPES,
  PLANNED_METHODS,
  REQUIRED_SCOPES,
  SCOPE_YOUTUBE,
  SCOPE_YOUTUBE_FORCE_SSL,
  SCOPE_YOUTUBE_READONLY,
  checkScopeCoverage,
  parseScopeString,
} from './scopes.js'
export type { MethodScopeEntry, PlannedMethod, ScopeCoverage } from './scopes.js'

export {
  AuthConfigError,
  CLIENT_ID_ENV,
  CLIENT_SECRET_ENV,
  CLIENT_SECRETS_FILE_ENV,
  loadOAuthClientCredentials,
  loadYouTubeAuthConfig,
  readClientSecretsFile,
} from './auth/config.js'
export type { OAuthClientCredentials, YouTubeAuthConfig } from './auth/config.js'
export {
  OAuthRequestError,
  classifyOAuthError,
  classifyOAuthErrorBody,
  isRevocation,
} from './auth/errors.js'
export type { FaultAction, OAuthFailure, OAuthFailureKind } from './auth/errors.js'
export { RecordingAuthEventSink, nullAuthEventSink } from './auth/events.js'
export type {
  AuthEvent,
  AuthEventSink,
  AuthRevokedEvent,
  AuthRevokedReason,
} from './auth/events.js'
export { GOOGLE_OAUTH_ENDPOINTS, OAuthClient } from './auth/oauth-client.js'
export type { OAuthEndpoints, RefreshResult, TokenSet } from './auth/oauth-client.js'
export {
  DEFAULT_LOOPBACK_HOST,
  LoginStateMismatchError,
  LoginTimeoutError,
  loginWithLoopback,
} from './auth/loopback-login.js'
export type { LoopbackLoginOptions, LoopbackLoginResult } from './auth/loopback-login.js'
export { AuthRevokedError, REFRESH_TOKEN_SECRET, TokenManager } from './auth/token-manager.js'
export type { TokenManagerOptions, TokenManagerState } from './auth/token-manager.js'

export {
  QUOTA_DAILY_DEFAULT_UNITS,
  QUOTA_RESET_TIME_ZONE,
  QUOTA_COSTS,
  provisionalQuotaMethods,
  quotaCostOf,
} from './quota/costs.js'
export type { QuotaCostEntry } from './quota/costs.js'
export { QuotaTracker, nextMidnightMs, quotaDayOf } from './quota/tracker.js'
export type { QuotaTrackerOptions, QuotaUsageSnapshot } from './quota/tracker.js'
export { GRPC_CODES, classifyYouTubeApiError } from './quota/classify.js'
export type { ApiErrorClassification, ApiErrorInput, ApiErrorKind } from './quota/classify.js'
export { createExponentialBackoff, decideRetry } from './quota/backoff.js'
export type { BackoffPolicy, ExponentialBackoffOptions, RetryDecision } from './quota/backoff.js'
export { loadQuotaConfig } from './quota/config.js'
export type { QuotaBackoffConfig, QuotaConfig } from './quota/config.js'
