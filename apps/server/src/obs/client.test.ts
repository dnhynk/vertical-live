import { afterEach, describe, expect, it } from 'vitest'

import type { HealthSignal } from '../health/types.js'
import { EnvSecretProvider, MissingSecretError } from '../secrets/index.js'
import { FakeClock } from '../testing/fake-clock.js'
import { FakeObsServer } from '../testing/fake-obs-server.js'
import { TEST_OBS_PASSWORD, testObsConfig, waitFor } from '../testing/obs-test-support.js'
import {
  ObsClient,
  ObsConnectTimeoutError,
  ObsNotConnectedError,
  OBS_CONNECTION_SIGNAL,
} from './client.js'
import { OBS_EVENT_SUBSCRIPTIONS, RPC_VERSION } from './protocol.js'

const secrets = new EnvSecretProvider({ VL_OBS_PASSWORD: TEST_OBS_PASSWORD })

let servers: FakeObsServer[] = []
let clients: ObsClient[] = []

async function startServer(
  ...args: Parameters<typeof FakeObsServer.start>
): Promise<FakeObsServer> {
  const server = await FakeObsServer.start(...args)
  servers.push(server)
  return server
}

function track(client: ObsClient): ObsClient {
  clients.push(client)
  return client
}

afterEach(async () => {
  await Promise.all(clients.map((client) => client.disconnect()))
  await Promise.all(servers.map((server) => server.close()))
  clients = []
  servers = []
})

describe('ObsClient handshake and authentication', () => {
  it('completes Hello → Identify → Identified against a v5 server', async () => {
    const server = await startServer({ password: TEST_OBS_PASSWORD })
    const signals: HealthSignal[] = []
    const client = track(
      new ObsClient({
        config: testObsConfig(server.url),
        secrets,
        clock: new FakeClock(),
        onSignal: (signal) => signals.push(signal),
      }),
    )

    await client.connect()

    expect(client.identified).toBe(true)
    expect(client.state).toBe('connected')
    expect(client.negotiatedRpcVersion).toBe(RPC_VERSION)
    expect(client.obsWebSocketVersion).toBe('5.6.3')
    expect(server.identifiedSessionCount).toBe(1)
    expect(signals.map((signal) => signal.detail['state'])).toEqual(['connecting', 'connected'])
    expect(signals.at(-1)).toMatchObject({
      component: 'obs',
      name: OBS_CONNECTION_SIGNAL,
      status: 'ok',
    })
  })

  it('answers the challenge with the algorithm obs-websocket-js expects', async () => {
    // The fake server computes the expected answer with our own
    // `buildAuthenticationString`; the client side is obs-websocket-js's
    // independent implementation. A successful Identify is therefore a
    // cross-implementation check of the auth algorithm, not a self-comparison.
    const server = await startServer({ password: TEST_OBS_PASSWORD })
    const client = track(
      new ObsClient({ config: testObsConfig(server.url), secrets, clock: new FakeClock() }),
    )

    await client.connect()

    expect(server.identifyLog).toEqual([
      { rpcVersion: RPC_VERSION, eventSubscriptions: OBS_EVENT_SUBSCRIPTIONS },
    ])
  })

  it('rejects a wrong password and does not start a reconnect loop', async () => {
    const server = await startServer({ password: TEST_OBS_PASSWORD })
    const clock = new FakeClock()
    const signals: HealthSignal[] = []
    const client = track(
      new ObsClient({
        config: testObsConfig(server.url),
        secrets: new EnvSecretProvider({ VL_OBS_PASSWORD: 'test-wrong-password' }),
        clock,
        onSignal: (signal) => signals.push(signal),
      }),
    )

    await expect(client.connect()).rejects.toThrow()

    expect(client.identified).toBe(false)
    expect(client.state).toBe('disconnected')
    expect(clock.pendingTimerCount).toBe(0)
    await clock.advance(60_000)
    expect(client.reconnectAttempts).toBe(0)
    expect(signals.at(-1)?.status).toBe('unknown')
  })

  it('refuses to connect when no websocket password is configured', async () => {
    const server = await startServer({ password: TEST_OBS_PASSWORD })
    const client = track(
      new ObsClient({
        config: testObsConfig(server.url),
        secrets: new EnvSecretProvider({}),
        clock: new FakeClock(),
      }),
    )

    await expect(client.connect()).rejects.toBeInstanceOf(MissingSecretError)
    expect(server.identifyLog).toEqual([])
  })

  it('does not read the environment when no provider is injected', async () => {
    // Review round 1, B1: the operational default is the OS credential vault
    // (spec §10.2), so `VL_OBS_PASSWORD` no longer authenticates a client that
    // was constructed without an explicit provider.
    const envPassword = 'synthetic-env-password-must-not-be-used'
    process.env['VL_OBS_PASSWORD'] = envPassword
    try {
      const server = await startServer({ password: envPassword })
      const client = track(
        new ObsClient({ config: testObsConfig(server.url), clock: new FakeClock() }),
      )

      const error = await client.connect().catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toContain(envPassword)
      // Not `expect(server.identifyLog).toEqual([])`: that also asserted the
      // host's credential vault is empty, so it failed on a host that has an
      // `obs.websocketPassword` stored. The invariant is that the environment
      // password is never used, and this server only accepts that password —
      // so an unidentified client proves it whatever the vault holds (T17b).
      expect(client.identified).toBe(false)
    } finally {
      delete process.env['VL_OBS_PASSWORD']
    }
  })

  it('has no unauthenticated path: a default fake server still challenges', async () => {
    // Review round 1 finding 1. There is no `allowUnauthenticated` escape hatch
    // any more, and the double cannot model an auth-disabled OBS either — so a
    // client that skipped authentication could not pass these tests.
    const server = await startServer()
    const unauthenticated = track(
      new ObsClient({
        config: testObsConfig(server.url),
        secrets: new EnvSecretProvider({}),
        clock: new FakeClock(),
      }),
    )

    await expect(unauthenticated.connect()).rejects.toBeInstanceOf(MissingSecretError)
    expect(server.identifyLog).toEqual([])

    const authenticated = track(
      new ObsClient({
        config: testObsConfig(server.url),
        secrets,
        clock: new FakeClock(),
      }),
    )
    await authenticated.connect()

    expect(authenticated.identified).toBe(true)
  })

  it('rejects a server whose RPC version we do not speak', async () => {
    const server = await startServer({ password: TEST_OBS_PASSWORD, rpcVersion: 99 })
    const client = track(
      new ObsClient({ config: testObsConfig(server.url), secrets, clock: new FakeClock() }),
    )

    await expect(client.connect()).rejects.toThrow()
    expect(server.identifyLog).toEqual([
      { rpcVersion: RPC_VERSION, eventSubscriptions: OBS_EVENT_SUBSCRIPTIONS },
    ])
    expect(client.identified).toBe(false)
  })

  it('refuses a non-loopback obs url', () => {
    expect(
      () =>
        new ObsClient({
          config: testObsConfig('ws://192.0.2.10:4455'),
          secrets,
          clock: new FakeClock(),
        }),
    ).toThrow(/loopback/)
  })

  it('closes the socket when the connect timeout wins, leaving no ghost connection', async () => {
    // Review round 1 finding 3. The Hello arrives after the connect timeout has
    // already fired; without closing the socket the handshake completes behind
    // the timeout and leaves an identified connection outside the state
    // machine (spec §10.2: one component, one supervisor).
    const server = await startServer({ password: TEST_OBS_PASSWORD, helloDelayMs: 150 })
    const clock = new FakeClock()
    const client = track(
      new ObsClient({
        config: testObsConfig(server.url, { connectTimeoutMs: 1000 }),
        secrets,
        clock,
      }),
    )

    // The expectation is attached before the clock advances: the rejection
    // happens inside advance(), and a handler attached afterwards would leave
    // it momentarily unobserved and trip vitest's unhandled-rejection check.
    const connecting = expect(client.connect()).rejects.toBeInstanceOf(ObsConnectTimeoutError)
    await waitFor(() => clock.pendingTimerCount === 1, 'connect timeout is armed')
    await clock.advance(1000)
    await connecting

    expect(client.state).toBe('disconnected')

    // Give the delayed Hello time to land, then confirm nothing came back up.
    await waitFor(() => server.openSessionCount === 0, 'server sees the socket closed')
    expect(client.identified).toBe(false)
    expect(server.identifiedSessionCount).toBe(0)
    await expect(client.call('GetVersion')).rejects.toBeInstanceOf(ObsNotConnectedError)
  })

  it('refuses requests while disconnected', async () => {
    const server = await startServer({ password: TEST_OBS_PASSWORD })
    const client = track(
      new ObsClient({ config: testObsConfig(server.url), secrets, clock: new FakeClock() }),
    )

    await expect(client.call('GetVersion')).rejects.toBeInstanceOf(ObsNotConnectedError)
  })
})

describe('ObsClient reconnection', () => {
  it('reconnects after the socket drops and counts the reconnect', async () => {
    const server = await startServer({ password: TEST_OBS_PASSWORD })
    const clock = new FakeClock()
    const signals: HealthSignal[] = []
    const client = track(
      new ObsClient({
        config: testObsConfig(server.url),
        secrets,
        clock,
        onSignal: (signal) => signals.push(signal),
      }),
    )
    await client.connect()

    server.dropAllConnections()
    await waitFor(() => client.state === 'reconnecting', 'client notices the closed socket')
    expect(clock.pendingTimerCount).toBe(1)

    await clock.advance(1000)
    await waitFor(() => client.state === 'connected', 'client reconnects')

    expect(client.reconnectCount).toBe(1)
    expect(client.reconnectAttempts).toBe(1)
    expect(signals.map((signal) => signal.detail['state'])).toEqual([
      'connecting',
      'connected',
      'reconnecting',
      'connected',
    ])

    // Review round 1 finding 4: the completed reconnect has to be visible in the
    // signal itself, not only through the getter — T12 aggregates signals, it
    // does not hold this object.
    expect(signals.map((signal) => signal.detail['reconnectCount'])).toEqual([0, 0, 0, 1])
    expect(signals.at(-1)).toMatchObject({ status: 'ok', detail: { state: 'connected' } })
    expect(await client.call('GetVersion')).toMatchObject({ obsWebSocketVersion: '5.6.3' })
  })

  it('backs off exponentially while the server keeps refusing, then recovers', async () => {
    const server = await startServer({ password: TEST_OBS_PASSWORD })
    const clock = new FakeClock()
    const signals: HealthSignal[] = []
    const client = track(
      new ObsClient({
        config: testObsConfig(server.url),
        secrets,
        clock,
        onSignal: (signal) => signals.push(signal),
      }),
    )
    await client.connect()

    server.rejectIdentify = true
    server.dropAllConnections()
    await waitFor(() => client.state === 'reconnecting', 'first close observed')

    // Backoff is initialDelayMs * factor^attempt: 1000, then 2000, then 4000.
    await clock.advance(999)
    expect(client.reconnectAttempts).toBe(0)

    await clock.advance(1)
    await waitFor(() => signals.length === 4, 'first retry fails')
    expect(client.reconnectAttempts).toBe(1)
    expect(client.state).toBe('reconnecting')

    await clock.advance(2000)
    await waitFor(() => signals.length === 5, 'second retry fails')
    expect(client.reconnectAttempts).toBe(2)
    expect(client.reconnectCount).toBe(0)

    server.rejectIdentify = false
    await clock.advance(4000)
    await waitFor(() => client.state === 'connected', 'third retry succeeds')
    expect(client.reconnectAttempts).toBe(3)
    expect(client.reconnectCount).toBe(1)
  })

  it('stops reconnecting after disconnect()', async () => {
    const server = await startServer({ password: TEST_OBS_PASSWORD })
    const clock = new FakeClock()
    const client = track(new ObsClient({ config: testObsConfig(server.url), secrets, clock }))
    await client.connect()

    await client.disconnect()
    server.dropAllConnections()
    await clock.advance(60_000)

    expect(client.state).toBe('disconnected')
    expect(client.reconnectAttempts).toBe(0)
    expect(clock.pendingTimerCount).toBe(0)
  })
})
