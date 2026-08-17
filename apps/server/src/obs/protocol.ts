import { createHash } from 'node:crypto'

/**
 * obs-websocket protocol v5 / RPC v1 constants.
 *
 * Source: obs-websocket `docs/generated/protocol.md`
 * (https://raw.githubusercontent.com/obsproject/obs-websocket/master/docs/generated/protocol.md,
 * read 2026-08-16). They are declared here rather than imported from
 * `obs-websocket-js` so that the fake server used in tests validates our client
 * against the *protocol*, not against the client library's own copy of it.
 */

/** RPC version this client speaks. OBS 32.0.2 / obs-websocket 5.6.3 serve RPC v1. */
export const RPC_VERSION = 1

export const WEBSOCKET_OP_CODE = {
  hello: 0,
  identify: 1,
  identified: 2,
  reidentify: 3,
  event: 5,
  request: 6,
  requestResponse: 7,
  requestBatch: 8,
  requestBatchResponse: 9,
} as const

/** Close codes obs-websocket uses to reject a connection. */
export const WEBSOCKET_CLOSE_CODE = {
  unknownReason: 4000,
  messageDecodeError: 4002,
  missingDataField: 4003,
  invalidDataFieldType: 4004,
  invalidDataFieldValue: 4005,
  unknownOpCode: 4006,
  notIdentified: 4007,
  alreadyIdentified: 4008,
  authenticationFailed: 4009,
  unsupportedRpcVersion: 4010,
  sessionInvalidated: 4011,
  unsupportedFeature: 4012,
} as const

/** `EventSubscription` bitflags. Only the categories this server needs. */
export const EVENT_SUBSCRIPTION = {
  none: 0,
  general: 1 << 0,
  config: 1 << 1,
  scenes: 1 << 2,
  inputs: 1 << 3,
  transitions: 1 << 4,
  filters: 1 << 5,
  outputs: 1 << 6,
  sceneItems: 1 << 7,
  mediaInputs: 1 << 8,
  vendors: 1 << 9,
  ui: 1 << 10,
} as const

/**
 * What T2 needs: `Outputs` carries `StreamStateChanged`, `Scenes` carries
 * `CurrentProgramSceneChanged`, `General` carries `ExitStarted`. Everything else
 * stays unsubscribed so a 24/7 session does not carry traffic nobody reads.
 */
export const OBS_EVENT_SUBSCRIPTIONS =
  EVENT_SUBSCRIPTION.general | EVENT_SUBSCRIPTION.scenes | EVENT_SUBSCRIPTION.outputs

/** `RequestStatus` codes referenced by this server. */
export const REQUEST_STATUS = {
  success: 100,
  unknownRequestType: 204,
  genericError: 205,
  missingRequestField: 300,
  invalidRequestFieldType: 401,
  outputRunning: 500,
  outputNotRunning: 501,
  resourceNotFound: 600,
  invalidResourceType: 602,
  resourceNotConfigurable: 606,
} as const

/** `ObsOutputState` identifier values reported by `StreamStateChanged`. */
export const OBS_OUTPUT_STATE = {
  unknown: 'OBS_WEBSOCKET_OUTPUT_UNKNOWN',
  starting: 'OBS_WEBSOCKET_OUTPUT_STARTING',
  started: 'OBS_WEBSOCKET_OUTPUT_STARTED',
  stopping: 'OBS_WEBSOCKET_OUTPUT_STOPPING',
  stopped: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
  reconnecting: 'OBS_WEBSOCKET_OUTPUT_RECONNECTING',
  reconnected: 'OBS_WEBSOCKET_OUTPUT_RECONNECTED',
  paused: 'OBS_WEBSOCKET_OUTPUT_PAUSED',
  resumed: 'OBS_WEBSOCKET_OUTPUT_RESUMED',
} as const

export type ObsOutputState = (typeof OBS_OUTPUT_STATE)[keyof typeof OBS_OUTPUT_STATE]

/**
 * `streamServiceType` for a server+key pair the caller supplies itself
 * (obs-studio `plugins/rtmp-services/rtmp-custom.c`). The server injects the
 * ingestion URL and the vault's stream key at runtime under this type instead
 * of relying on a service configured in the OBS UI.
 */
export const CUSTOM_STREAM_SERVICE_TYPE = 'rtmp_custom'

/** The property button obs-browser exposes for "Refresh cache of current page". */
export const BROWSER_SOURCE_REFRESH_PROPERTY = 'refreshnocache'

/** obs-browser's input kind, checked before a refresh is attempted. */
export const BROWSER_SOURCE_INPUT_KIND = 'browser_source'

/**
 * `Hello.authentication` challenge answer:
 * base64(sha256(base64(sha256(password + salt)) + challenge)).
 *
 * The example `Hello` and `Identify` messages in protocol.md are from different
 * sessions (recomputing the documented answer from the documented salt and
 * challenge does not reproduce it), so they are not a usable test vector; this
 * implementation is validated by a real `obs-websocket-js` client completing the
 * handshake against the fake server that uses it.
 */
export function buildAuthenticationString(
  password: string,
  salt: string,
  challenge: string,
): string {
  const secret = createHash('sha256')
    .update(password + salt)
    .digest('base64')
  return createHash('sha256')
    .update(secret + challenge)
    .digest('base64')
}
