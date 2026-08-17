import { describe, expect, it } from 'vitest'

import { classifyYouTubeApiError } from '../quota/classify.js'
import { YouTubeApiCallError, type ApiCallOutcome } from './api.js'
import {
  ADOPTABLE_LIFE_CYCLE_STATUSES,
  classifyBroadcastLimit,
  isAdoptableLifeCycleStatus,
  isLiveLifeCycleStatus,
} from './limits.js'
import { StreamKeyCustodian } from './stream-key.js'
import { InMemorySecretVault } from '../../secrets/memory.js'
import { SecretRedactor } from '../../secrets/redaction.js'
import type { SecretName } from '../../secrets/types.js'
import type { SecretVault } from '../../secrets/vault.js'

/**
 * The limit classifier and the stream-key custodian, unit level. The behavioural
 * consequences (recover first, then safe stop) are covered in `lifecycle.test.ts`.
 */

function apiError(
  reason: string | undefined,
  httpStatus: number,
  outcome: ApiCallOutcome = 'rejected',
): YouTubeApiCallError {
  const body =
    reason === undefined
      ? undefined
      : { error: { code: httpStatus, errors: [{ reason, domain: 'youtube.liveBroadcast' }] } }
  return new YouTubeApiCallError(
    'liveBroadcasts.insert',
    outcome,
    classifyYouTubeApiError({ httpStatus, ...(body === undefined ? {} : { body }) }),
  )
}

describe('classifyBroadcastLimit', () => {
  it('recognises the three documented channel limits', () => {
    expect(classifyBroadcastLimit(apiError('userBroadcastsExceedLimit', 403))).toBe(
      'user_broadcasts',
    )
    expect(classifyBroadcastLimit(apiError('concurrentBroadcastsExceedLimit', 403))).toBe(
      'concurrent_broadcasts',
    )
    expect(classifyBroadcastLimit(apiError('sharedIngestionBroadcastsExceedLimit', 403))).toBe(
      'shared_ingestion',
    )
  })

  it('treats a limit-shaped unknown reason as the undocumented daily limit', () => {
    // YouTube Help states a daily creation limit exists but publishes no number and
    // no reason string (see limits.ts). Both suffix spellings are covered.
    expect(classifyBroadcastLimit(apiError('syntheticCreationExceedLimit', 403))).toBe(
      'daily_creation',
    )
    expect(classifyBroadcastLimit(apiError('syntheticCreationLimitExceeded', 403))).toBe(
      'daily_creation',
    )
  })

  it('does not mistake a rate limit or a quota exhaustion for a channel limit', () => {
    // Both reasons end in "LimitExceeded"/"RateLimit" and mean "wait", not "full".
    expect(classifyBroadcastLimit(apiError('rateLimitExceeded', 403))).toBeNull()
    expect(classifyBroadcastLimit(apiError('userRequestsExceedRateLimit', 403))).toBeNull()
    expect(classifyBroadcastLimit(apiError('quotaExceeded', 403))).toBeNull()
    expect(classifyBroadcastLimit(apiError('dailyLimitExceeded', 403))).toBeNull()
  })

  it('does not treat ordinary rejections as limits', () => {
    expect(classifyBroadcastLimit(apiError('liveStreamingNotEnabled', 403))).toBeNull()
    expect(classifyBroadcastLimit(apiError('invalidAutoStart', 400))).toBeNull()
    expect(classifyBroadcastLimit(apiError(undefined, 500, 'uncertain'))).toBeNull()
  })
})

describe('adoptable lifecycle statuses', () => {
  it('excludes the two that cannot be recovered', () => {
    expect(ADOPTABLE_LIFE_CYCLE_STATUSES).not.toContain('complete')
    expect(ADOPTABLE_LIFE_CYCLE_STATUSES).not.toContain('revoked')
    expect(isAdoptableLifeCycleStatus('testing')).toBe(true)
    expect(isAdoptableLifeCycleStatus('complete')).toBe(false)
    expect(isAdoptableLifeCycleStatus(null)).toBe(false)
    expect(isLiveLifeCycleStatus('liveStarting')).toBe(true)
    expect(isLiveLifeCycleStatus('testing')).toBe(false)
  })
})

describe('StreamKeyCustodian', () => {
  it('writes only the selected stream’s key and forgets the rest', async () => {
    const vault = new InMemorySecretVault()
    const custodian = new StreamKeyCustodian({ vault })

    await custodian.sink('synthetic-stream-1', 'synthetic-key-0001')
    await custodian.sink('synthetic-stream-2', 'synthetic-key-0002')
    expect(custodian.stagedStreamIds).toEqual(['synthetic-stream-1', 'synthetic-stream-2'])

    expect(await custodian.commit('synthetic-stream-2', { required: true })).toBe(true)

    expect(await vault.get('youtube.streamKey')).toBe('synthetic-key-0002')
    expect(custodian.stagedStreamIds).toEqual([])
  })

  it('refuses to accept a created stream with no key', async () => {
    const custodian = new StreamKeyCustodian({ vault: new InMemorySecretVault() })

    await expect(custodian.commit('synthetic-stream-1', { required: true })).rejects.toThrow(
      /without an ingestion stream key/,
    )
  })

  it('keeps the stored key when a reused stream reports none', async () => {
    const vault = new InMemorySecretVault({ 'youtube.streamKey': 'synthetic-key-previous' })
    const custodian = new StreamKeyCustodian({ vault })

    expect(await custodian.commit('synthetic-stream-1', { required: false })).toBe(false)
    expect(await vault.get('youtube.streamKey')).toBe('synthetic-key-previous')
  })

  it('does not rewrite an unchanged key', async () => {
    const writes: SecretName[] = []
    const inner = new InMemorySecretVault({ 'youtube.streamKey': 'synthetic-key-0001' })
    const vault: SecretVault = {
      source: inner.source,
      get: (name) => inner.get(name),
      set: async (name, value) => {
        writes.push(name)
        await inner.set(name, value)
      },
      delete: (name) => inner.delete(name),
    }
    const custodian = new StreamKeyCustodian({ vault })

    await custodian.sink('synthetic-stream-1', 'synthetic-key-0001')
    expect(await custodian.commit('synthetic-stream-1', { required: true })).toBe(false)
    expect(writes).toEqual([])
  })

  it('registers keys with the redactor and drops them on discard', async () => {
    const redactor = new SecretRedactor()
    const custodian = new StreamKeyCustodian({ vault: new InMemorySecretVault(), redactor })

    await custodian.sink('synthetic-stream-1', 'synthetic-key-0001')
    custodian.discard()

    expect(custodian.stagedStreamIds).toEqual([])
    expect(redactor.redact('key=synthetic-key-0001')).toBe('key=[redacted]')
  })
})
