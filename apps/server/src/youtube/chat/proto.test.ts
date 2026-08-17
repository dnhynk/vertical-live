import { readFileSync } from 'node:fs'

import { loadSync } from '@grpc/proto-loader'
import { describe, expect, it } from 'vitest'

import { PROTO_LOADER_OPTIONS, STREAM_LIST_PROTO_PATH, loadStreamListClientClass } from './transport.js'

/**
 * The copied proto is a fact about YouTube's wire contract, not our code
 * (TASK_SPECS §T9: "[S4]의 proto를 …로 복사(출처 URL·복사 날짜 헤더)"). These
 * tests pin the two things a future edit could quietly break: that the file
 * still says where it came from, and that the messages and fields this product
 * reads are the ones the guide publishes.
 */

const source = readFileSync(STREAM_LIST_PROTO_PATH, 'utf8')

describe('stream_list.proto provenance', () => {
  it('records the source URL and the copy date in its header', () => {
    expect(source).toContain(
      'https://developers.google.com/youtube/v3/live/streaming-live-chat',
    )
    expect(source).toMatch(/copied:\s+2026-08-17/)
  })

  it('declares exactly one deviation from the published listing', () => {
    const marked = source.split('\n').filter((line) => line.includes('[vertical-live]'))
    // One marker in the header's explanation, one on the added import line.
    expect(marked).toHaveLength(2)
    expect(source).toContain('import "google/protobuf/duration.proto";')
  })
})

describe('stream_list.proto contents', () => {
  const definition = loadSync(STREAM_LIST_PROTO_PATH, PROTO_LOADER_OPTIONS)

  it('exposes the server-streaming StreamList rpc', () => {
    const Client = loadStreamListClientClass()
    expect(typeof Client).toBe('function')
    const service = definition['youtube.api.v3.V3DataLiveChatMessageService']
    expect(service).toBeDefined()
    expect(Object.keys(service as object)).toEqual(['StreamList'])
  })

  it('keeps the request fields the source sets, in snake_case', () => {
    const request = definition['youtube.api.v3.LiveChatMessageListRequest'] as {
      type: { field: { name: string }[] }
    }
    const names = request.type.field.map((field) => field.name)
    expect(names).toContain('live_chat_id')
    expect(names).toContain('part')
    expect(names).toContain('page_token')
    expect(names).toContain('max_results')
  })

  it('keeps the response fields the source reads', () => {
    const response = definition['youtube.api.v3.LiveChatMessageListResponse'] as {
      type: { field: { name: string }[] }
    }
    const names = response.type.field.map((field) => field.name)
    expect(names).toContain('items')
    expect(names).toContain('next_page_token')
    expect(names).toContain('offline_at')
    // The streaming response has no polling interval — that field belongs to the
    // REST `list` resource only ([S3]), which is why only the fallback paces
    // itself by the server's value.
    expect(names).not.toContain('polling_interval_millis')
  })

  it('still declares author_details, which is precisely what we never request', () => {
    const message = definition['youtube.api.v3.LiveChatMessage'] as {
      type: { field: { name: string }[] }
    }
    const names = message.type.field.map((field) => field.name)
    expect(names).toContain('author_details')
  })
})
