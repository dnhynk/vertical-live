#!/usr/bin/env node
/**
 * Local preview harness: a loopback `/ws/renderer` endpoint that serves one
 * synthetic snapshot and one synthetic effect so the 1080x1920 screen can be
 * looked at, screenshotted and smoke-tested against a real WebSocket
 * (TASK_SPECS §T5 acceptance 3).
 *
 * It is a developer tool, not a product path: the authoritative server is T8
 * and the scenario injector is T11. Every value it sends comes from
 * `src/testing/fixtures.ts`, which carries plainly synthetic `sample-` values
 * only (CLAUDE.md §3) and is validated by the contract schemas.
 *
 * Run `npm run build -w @vl/contract` first (this imports the built contract),
 * then:
 *
 *   node apps/renderer/scripts/preview-server.mjs
 *   npm run dev -w @vl/renderer      # or: npx vite preview
 *   open http://127.0.0.1:5173/?mode=dev
 */
import { WebSocketServer } from 'ws'

import {
  effectMessage,
  sampleActionEffect,
  sampleSnapshot,
  snapshotMessage,
} from '../src/testing/fixtures.ts'

const PORT = Number(process.env.VL_PORT ?? '8787')
const PING_INTERVAL_MS = 5_000
const EFFECT_WINDOW_MS = 60_000

const server = new WebSocketServer({ host: '127.0.0.1', port: PORT, path: '/ws/renderer' })

server.on('listening', () => {
  console.log(`preview harness listening on ws://127.0.0.1:${String(PORT)}/ws/renderer`)
})

server.on('connection', (socket) => {
  console.log('renderer connected')
  let pingTimer = null

  socket.on('message', (raw) => {
    let message
    try {
      message = JSON.parse(raw.toString())
    } catch {
      console.log('<- unparseable frame')
      return
    }
    console.log('<-', JSON.stringify(message))

    if (message.type !== 'hello') return

    const now = Date.now()
    socket.send(JSON.stringify(snapshotMessage(sampleSnapshot())))
    socket.send(
      JSON.stringify(
        effectMessage(
          sampleActionEffect({
            startsAt: new Date(now).toISOString(),
            endsAt: new Date(now + EFFECT_WINDOW_MS).toISOString(),
          }),
        ),
      ),
    )
    console.log('-> snapshot + effect')

    pingTimer = setInterval(() => {
      socket.send(
        JSON.stringify({
          schemaVersion: 1,
          sentAt: new Date().toISOString(),
          type: 'ping',
        }),
      )
    }, PING_INTERVAL_MS)
  })

  socket.on('close', () => {
    if (pingTimer !== null) clearInterval(pingTimer)
    console.log('renderer disconnected')
  })
})
