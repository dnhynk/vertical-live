import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'

import {
  buildAuthenticationString,
  EVENT_SUBSCRIPTION,
  REQUEST_STATUS,
  RPC_VERSION,
  WEBSOCKET_CLOSE_CODE,
  WEBSOCKET_OP_CODE,
} from '../obs/protocol.js'

/**
 * A fake obs-websocket **protocol v5 / RPC v1** server for tests.
 *
 * It speaks the wire protocol (`docs/generated/protocol.md`) rather than reusing
 * `obs-websocket-js`, so the client under test is validated against the protocol
 * and not against the library's own idea of it. All state is obviously synthetic
 * (`test-*` names) per CLAUDE.md §3.
 */

export interface FakeStreamStatus {
  outputActive: boolean
  outputReconnecting: boolean
  outputTimecode: string
  outputDuration: number
  outputCongestion: number
  outputBytes: number
  outputSkippedFrames: number
  outputTotalFrames: number
}

export interface FakeStats {
  cpuUsage: number
  memoryUsage: number
  availableDiskSpace: number
  activeFps: number
  averageFrameRenderTime: number
  renderSkippedFrames: number
  renderTotalFrames: number
  outputSkippedFrames: number
  outputTotalFrames: number
  webSocketSessionIncomingMessages: number
  webSocketSessionOutgoingMessages: number
}

export interface FakeInput {
  inputName: string
  inputKind: string
  unversionedInputKind: string
}

export interface FakeVideoSettings {
  fpsNumerator: number
  fpsDenominator: number
  baseWidth: number
  baseHeight: number
  outputWidth: number
  outputHeight: number
}

export interface FakeObsState {
  streamStatus: FakeStreamStatus
  stats: FakeStats
  scenes: string[]
  currentProgramSceneName: string
  inputs: FakeInput[]
  videoSettings: FakeVideoSettings
  obsVersion: string
  obsWebSocketVersion: string
  platform: string
}

export interface ButtonPress {
  readonly inputName: string
  readonly propertyName: string
}

export interface RequestLogEntry {
  readonly requestType: string
  readonly requestData: unknown
}

export interface IdentifyLogEntry {
  readonly rpcVersion: number
  readonly eventSubscriptions: number
}

export interface FakeObsServerOptions {
  /** When set, `Hello` carries a challenge and `Identify` must answer it. */
  readonly password?: string
  /** RPC version the server offers and requires. Defaults to 1. */
  readonly rpcVersion?: number
  readonly state?: Partial<FakeObsState>
}

interface Session {
  readonly socket: WebSocket
  identified: boolean
  eventSubscriptions: number
  challenge: string
  salt: string
}

function defaultState(): FakeObsState {
  return {
    streamStatus: {
      outputActive: false,
      outputReconnecting: false,
      outputTimecode: '00:00:00.000',
      outputDuration: 0,
      outputCongestion: 0,
      outputBytes: 0,
      outputSkippedFrames: 0,
      outputTotalFrames: 0,
    },
    stats: {
      cpuUsage: 1,
      memoryUsage: 100,
      availableDiskSpace: 100_000,
      activeFps: 30,
      averageFrameRenderTime: 2,
      renderSkippedFrames: 0,
      renderTotalFrames: 0,
      outputSkippedFrames: 0,
      outputTotalFrames: 0,
      webSocketSessionIncomingMessages: 0,
      webSocketSessionOutgoingMessages: 0,
    },
    scenes: ['test-scene-live', 'test-scene-standby'],
    currentProgramSceneName: 'test-scene-live',
    inputs: [
      {
        inputName: 'test-browser-source',
        inputKind: 'browser_source',
        unversionedInputKind: 'browser_source',
      },
      { inputName: 'test-color-source', inputKind: 'color_source_v3', unversionedInputKind: 'color_source' },
    ],
    videoSettings: {
      fpsNumerator: 30,
      fpsDenominator: 1,
      baseWidth: 1080,
      baseHeight: 1920,
      outputWidth: 1080,
      outputHeight: 1920,
    },
    obsVersion: '32.0.2',
    obsWebSocketVersion: '5.6.3',
    platform: 'windows',
  }
}

export class FakeObsServer {
  readonly state: FakeObsState
  readonly requestLog: RequestLogEntry[] = []
  readonly identifyLog: IdentifyLogEntry[] = []
  readonly buttonPresses: ButtonPress[] = []

  /** Flip on to make every subsequent `Identify` fail authentication. */
  rejectIdentify = false

  readonly #wss: WebSocketServer
  readonly #password: string | undefined
  readonly #rpcVersion: number
  readonly #sessions = new Set<Session>()
  readonly #port: number

  private constructor(wss: WebSocketServer, port: number, options: FakeObsServerOptions) {
    this.#wss = wss
    this.#port = port
    this.#password = options.password
    this.#rpcVersion = options.rpcVersion ?? RPC_VERSION
    this.state = { ...defaultState(), ...options.state }
    this.#wss.on('connection', (socket) => {
      this.#onConnection(socket)
    })
  }

  static async start(options: FakeObsServerOptions = {}): Promise<FakeObsServer> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve)
      wss.once('error', reject)
    })
    const { port } = wss.address() as AddressInfo
    return new FakeObsServer(wss, port, options)
  }

  get url(): string {
    return `ws://127.0.0.1:${this.#port}`
  }

  get identifiedSessionCount(): number {
    let count = 0
    for (const session of this.#sessions) {
      if (session.identified) {
        count += 1
      }
    }
    return count
  }

  /** Sends a v5 `Event` to every identified session subscribed to `intent`. */
  emitEvent(eventType: string, eventData: Record<string, unknown>, intent: number): void {
    for (const session of this.#sessions) {
      if (!session.identified || (session.eventSubscriptions & intent) === 0) {
        continue
      }
      send(session.socket, {
        op: WEBSOCKET_OP_CODE.event,
        d: { eventType, eventIntent: intent, eventData },
      })
    }
  }

  /** Drops every connection, as an OBS restart or a lost socket would. */
  dropAllConnections(code = WEBSOCKET_CLOSE_CODE.sessionInvalidated): void {
    for (const session of this.#sessions) {
      session.socket.close(code, 'test drop')
    }
  }

  async close(): Promise<void> {
    for (const session of this.#sessions) {
      session.socket.terminate()
    }
    this.#sessions.clear()
    await new Promise<void>((resolve, reject) => {
      this.#wss.close((error) => (error ? reject(error) : resolve()))
    })
  }

  #onConnection(socket: WebSocket): void {
    const session: Session = {
      socket,
      identified: false,
      eventSubscriptions: 0,
      challenge: randomBytes(16).toString('base64'),
      salt: randomBytes(16).toString('base64'),
    }
    this.#sessions.add(session)
    socket.on('close', () => {
      this.#sessions.delete(session)
    })
    socket.on('message', (raw) => {
      this.#onMessage(session, raw.toString())
    })

    send(socket, {
      op: WEBSOCKET_OP_CODE.hello,
      d: {
        obsWebSocketVersion: this.state.obsWebSocketVersion,
        rpcVersion: this.#rpcVersion,
        ...(this.#password === undefined
          ? {}
          : { authentication: { challenge: session.challenge, salt: session.salt } }),
      },
    })
  }

  #onMessage(session: Session, raw: string): void {
    let message: { op?: unknown; d?: unknown }
    try {
      message = JSON.parse(raw) as { op?: unknown; d?: unknown }
    } catch {
      session.socket.close(WEBSOCKET_CLOSE_CODE.messageDecodeError, 'not json')
      return
    }
    const data = (message.d ?? {}) as Record<string, unknown>

    switch (message.op) {
      case WEBSOCKET_OP_CODE.identify:
        this.#onIdentify(session, data)
        return
      case WEBSOCKET_OP_CODE.request:
        this.#onRequest(session, data)
        return
      default:
        session.socket.close(WEBSOCKET_CLOSE_CODE.unknownOpCode, 'unsupported op')
    }
  }

  #onIdentify(session: Session, data: Record<string, unknown>): void {
    if (session.identified) {
      session.socket.close(WEBSOCKET_CLOSE_CODE.alreadyIdentified, 'already identified')
      return
    }
    const rpcVersion = data['rpcVersion']
    if (typeof rpcVersion !== 'number') {
      session.socket.close(WEBSOCKET_CLOSE_CODE.missingDataField, 'rpcVersion')
      return
    }
    this.identifyLog.push({
      rpcVersion,
      eventSubscriptions: typeof data['eventSubscriptions'] === 'number' ? data['eventSubscriptions'] : 0,
    })
    if (rpcVersion !== this.#rpcVersion) {
      session.socket.close(WEBSOCKET_CLOSE_CODE.unsupportedRpcVersion, 'unsupported rpc version')
      return
    }
    if (this.#password !== undefined) {
      const expected = buildAuthenticationString(this.#password, session.salt, session.challenge)
      if (this.rejectIdentify || data['authentication'] !== expected) {
        session.socket.close(WEBSOCKET_CLOSE_CODE.authenticationFailed, 'authentication failed')
        return
      }
    } else if (this.rejectIdentify) {
      session.socket.close(WEBSOCKET_CLOSE_CODE.authenticationFailed, 'authentication failed')
      return
    }

    session.identified = true
    session.eventSubscriptions =
      typeof data['eventSubscriptions'] === 'number' ? data['eventSubscriptions'] : EVENT_SUBSCRIPTION.none
    send(session.socket, {
      op: WEBSOCKET_OP_CODE.identified,
      d: { negotiatedRpcVersion: this.#rpcVersion },
    })
  }

  #onRequest(session: Session, data: Record<string, unknown>): void {
    if (!session.identified) {
      session.socket.close(WEBSOCKET_CLOSE_CODE.notIdentified, 'not identified')
      return
    }
    const requestType = String(data['requestType'] ?? '')
    const requestId = String(data['requestId'] ?? '')
    const requestData = (data['requestData'] ?? {}) as Record<string, unknown>
    this.requestLog.push({ requestType, requestData: data['requestData'] })

    const outcome = this.#handle(requestType, requestData)
    send(session.socket, {
      op: WEBSOCKET_OP_CODE.requestResponse,
      d: {
        requestType,
        requestId,
        requestStatus:
          outcome.code === REQUEST_STATUS.success
            ? { result: true, code: outcome.code }
            : { result: false, code: outcome.code, comment: outcome.comment ?? '' },
        ...(outcome.responseData === undefined ? {} : { responseData: outcome.responseData }),
      },
    })
  }

  #handle(requestType: string, requestData: Record<string, unknown>): RequestOutcome {
    const state = this.state
    switch (requestType) {
      case 'GetVersion':
        return ok({
          obsVersion: state.obsVersion,
          obsWebSocketVersion: state.obsWebSocketVersion,
          rpcVersion: this.#rpcVersion,
          availableRequests: ['GetVersion', 'GetStreamStatus', 'GetStats'],
          supportedImageFormats: ['png'],
          platform: state.platform,
          platformDescription: 'fake obs-websocket v5 server',
        })

      case 'GetStats':
        return ok({ ...state.stats })

      case 'GetStreamStatus':
        return ok({ ...state.streamStatus })

      case 'GetVideoSettings':
        return ok({ ...state.videoSettings })

      case 'StartStream':
        if (state.streamStatus.outputActive) {
          return fail(REQUEST_STATUS.outputRunning, 'stream already active')
        }
        state.streamStatus.outputActive = true
        return ok(undefined)

      case 'StopStream':
        if (!state.streamStatus.outputActive) {
          return fail(REQUEST_STATUS.outputNotRunning, 'stream not active')
        }
        state.streamStatus.outputActive = false
        state.streamStatus.outputReconnecting = false
        return ok(undefined)

      case 'GetSceneList':
        return ok({
          currentProgramSceneName: state.currentProgramSceneName,
          currentProgramSceneUuid: `uuid-${state.currentProgramSceneName}`,
          currentPreviewSceneName: '',
          currentPreviewSceneUuid: '',
          scenes: state.scenes.map((sceneName, index) => ({
            sceneName,
            sceneUuid: `uuid-${sceneName}`,
            sceneIndex: index,
          })),
        })

      case 'GetCurrentProgramScene':
        return ok({
          sceneName: state.currentProgramSceneName,
          sceneUuid: `uuid-${state.currentProgramSceneName}`,
          currentProgramSceneName: state.currentProgramSceneName,
          currentProgramSceneUuid: `uuid-${state.currentProgramSceneName}`,
        })

      case 'SetCurrentProgramScene': {
        const sceneName = requestData['sceneName']
        if (typeof sceneName !== 'string') {
          return fail(REQUEST_STATUS.missingRequestField, 'sceneName')
        }
        if (!state.scenes.includes(sceneName)) {
          return fail(REQUEST_STATUS.resourceNotFound, 'no such scene')
        }
        state.currentProgramSceneName = sceneName
        return ok(undefined)
      }

      case 'GetInputList': {
        const inputKind = requestData['inputKind']
        const inputs =
          typeof inputKind === 'string'
            ? state.inputs.filter((input) => input.inputKind === inputKind)
            : state.inputs
        return ok({ inputs: inputs.map((input) => ({ ...input, inputUuid: `uuid-${input.inputName}` })) })
      }

      case 'PressInputPropertiesButton': {
        const inputName = requestData['inputName']
        const propertyName = requestData['propertyName']
        if (typeof inputName !== 'string' || typeof propertyName !== 'string') {
          return fail(REQUEST_STATUS.missingRequestField, 'inputName/propertyName')
        }
        const input = state.inputs.find((entry) => entry.inputName === inputName)
        if (input === undefined) {
          return fail(REQUEST_STATUS.resourceNotFound, 'no such input')
        }
        if (input.unversionedInputKind !== 'browser_source' || propertyName !== 'refreshnocache') {
          return fail(REQUEST_STATUS.resourceNotConfigurable, 'no such button property')
        }
        this.buttonPresses.push({ inputName, propertyName })
        return ok(undefined)
      }

      default:
        return fail(REQUEST_STATUS.unknownRequestType, `unknown request type ${requestType}`)
    }
  }
}

interface RequestOutcome {
  readonly code: number
  readonly responseData?: Record<string, unknown> | undefined
  readonly comment?: string
}

function ok(responseData: Record<string, unknown> | undefined): RequestOutcome {
  return { code: REQUEST_STATUS.success, responseData }
}

function fail(code: number, comment: string): RequestOutcome {
  return { code, comment }
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload))
  }
}
