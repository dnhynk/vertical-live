import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  buildAuthenticationString,
  EVENT_SUBSCRIPTION,
  OBS_EVENT_SUBSCRIPTIONS,
  RPC_VERSION,
  WEBSOCKET_CLOSE_CODE,
  WEBSOCKET_OP_CODE,
} from './protocol.js'

describe('protocol v5 constants', () => {
  it('speaks RPC v1', () => {
    expect(RPC_VERSION).toBe(1)
  })

  it('uses the documented opcodes', () => {
    expect(WEBSOCKET_OP_CODE).toMatchObject({
      hello: 0,
      identify: 1,
      identified: 2,
      event: 5,
      request: 6,
      requestResponse: 7,
    })
  })

  it('uses the documented close codes for a refused connection', () => {
    expect(WEBSOCKET_CLOSE_CODE.authenticationFailed).toBe(4009)
    expect(WEBSOCKET_CLOSE_CODE.unsupportedRpcVersion).toBe(4010)
    expect(WEBSOCKET_CLOSE_CODE.notIdentified).toBe(4007)
  })

  it('subscribes to exactly the categories T2 reads', () => {
    expect(OBS_EVENT_SUBSCRIPTIONS).toBe(
      EVENT_SUBSCRIPTION.general | EVENT_SUBSCRIPTION.scenes | EVENT_SUBSCRIPTION.outputs,
    )
    // Nothing else is carried on a 24/7 session.
    expect(OBS_EVENT_SUBSCRIPTIONS & EVENT_SUBSCRIPTION.inputs).toBe(0)
    expect(OBS_EVENT_SUBSCRIPTIONS & EVENT_SUBSCRIPTION.sceneItems).toBe(0)
    expect(OBS_EVENT_SUBSCRIPTIONS & EVENT_SUBSCRIPTION.mediaInputs).toBe(0)
  })
})

describe('buildAuthenticationString', () => {
  const password = 'test-obs-websocket-password'
  const salt = 'test-salt'
  const challenge = 'test-challenge'

  it('is base64(sha256(base64(sha256(password + salt)) + challenge))', () => {
    const secret = createHash('sha256')
      .update(`${password}${salt}`, 'utf8')
      .digest()
      .toString('base64')
    const expected = createHash('sha256')
      .update(`${secret}${challenge}`, 'utf8')
      .digest()
      .toString('base64')

    expect(buildAuthenticationString(password, salt, challenge)).toBe(expected)
  })

  it('produces a base64 sha256 digest', () => {
    const answer = buildAuthenticationString(password, salt, challenge)

    expect(answer).toHaveLength(44)
    expect(answer).toMatch(/^[A-Za-z0-9+/]{43}=$/)
  })

  it('changes with the password, the salt and the challenge', () => {
    const base = buildAuthenticationString(password, salt, challenge)

    expect(buildAuthenticationString('test-other-password', salt, challenge)).not.toBe(base)
    expect(buildAuthenticationString(password, 'test-other-salt', challenge)).not.toBe(base)
    expect(buildAuthenticationString(password, salt, 'test-other-challenge')).not.toBe(base)
  })
})
