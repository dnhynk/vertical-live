import type { OBSEventTypes, OBSRequestTypes, OBSResponseTypes } from 'obs-websocket-js/json'

/**
 * The part of `ObsClient` that the health producer and the control commands
 * need. Declared separately so those modules depend on "something that can
 * issue v5 requests and receive v5 events", not on the reconnect supervisor.
 */
export interface ObsRequester {
  call<T extends keyof OBSRequestTypes>(
    requestType: T,
    requestData?: OBSRequestTypes[T],
  ): Promise<OBSResponseTypes[T]>
  on<K extends keyof OBSEventTypes>(event: K, listener: (data: OBSEventTypes[K]) => void): void
  off<K extends keyof OBSEventTypes>(event: K, listener: (data: OBSEventTypes[K]) => void): void
}
