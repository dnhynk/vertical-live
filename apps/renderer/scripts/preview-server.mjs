#!/usr/bin/env node
/**
 * Local preview harness: a loopback `/ws/renderer` endpoint that serves one of
 * the six representative states of TASK_SPECS §T14 so the 1080x1920 screen can
 * be looked at, screenshotted and smoke-tested against a real WebSocket.
 *
 * It is a developer tool, not a product path: the authoritative server is T8 and
 * the scenario injector is T11. Every value it sends comes from
 * `src/testing/preview-states.ts`, which is validated by the contract schemas and
 * carries plainly synthetic participation ids (CLAUDE.md §3).
 *
 * Which state is served is chosen by the renderer's own WebSocket URL, so one
 * server can serve all six:
 *
 *   npm run build -w @vl/contract          # this imports the built contract
 *   node apps/renderer/scripts/preview-server.mjs
 *   npm run dev -w @vl/renderer
 *   http://127.0.0.1:5173/?mode=dev&ws=ws%3A%2F%2F127.0.0.1%3A8787%2Fws%2Frenderer%3Fstate%3Dhungry
 *
 * `node apps/renderer/scripts/capture.mjs` drives exactly that automatically.
 */
import { WebSocketServer } from 'ws'

import { PREVIEW_STATES, previewState } from '../src/testing/preview-states.ts'

const DEFAULT_PORT = Number(process.env.VL_PORT ?? '8787')
const PING_INTERVAL_MS = 5_000
const DEFAULT_STATE = 'calm'

function envelope(type, body) {
  return JSON.stringify({
    schemaVersion: 1,
    sentAt: new Date().toISOString(),
    type,
    ...body,
  })
}

/**
 * Effect windows are absolute instants (spec §7.3(6)), so the fixtures are
 * shifted onto the current clock before they go out; otherwise the renderer
 * would drop them as expired.
 */
function onNow(effect, nowMs) {
  const startsAt = new Date(nowMs - 1_000).toISOString()
  const endsAt = new Date(nowMs + 600_000).toISOString()
  return { ...effect, startsAt, endsAt }
}

function shiftSnapshot(snapshot, nowMs) {
  const shift = (iso) => {
    if (iso === null || iso === undefined) return iso
    const base = Date.parse(snapshot.worldTimeUtc)
    return new Date(nowMs + (Date.parse(iso) - base)).toISOString()
  }
  return {
    ...snapshot,
    worldTimeUtc: new Date(nowMs).toISOString(),
    nextTransitionAt: shift(snapshot.nextTransitionAt),
    mission:
      snapshot.mission === null
        ? null
        : { ...snapshot.mission, choiceClosesAt: shift(snapshot.mission.choiceClosesAt) },
    display: {
      ...snapshot.display,
      lastAppliedAction:
        snapshot.display.lastAppliedAction === null
          ? null
          : {
              ...snapshot.display.lastAppliedAction,
              appliedAt: shift(snapshot.display.lastAppliedAction.appliedAt),
            },
      nextChoiceAt: shift(snapshot.display.nextChoiceAt),
      aggregateWindow:
        snapshot.display.aggregateWindow === undefined
          ? undefined
          : {
              ...snapshot.display.aggregateWindow,
              endsAt: shift(snapshot.display.aggregateWindow.endsAt),
            },
    },
  }
}

/**
 * Starts the harness. `onHealth` receives every `renderer_health` frame, which is
 * how `capture.mjs` measures the sustained frame rate against a wall clock.
 */
export function startPreviewServer({ port = DEFAULT_PORT, log = console.log, onHealth } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port, path: '/ws/renderer' })

  server.on('connection', (socket, request) => {
    const query = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams
    const name = query.get('state') ?? DEFAULT_STATE
    const state = previewState(name)
    if (state === undefined) {
      log(`unknown preview state: ${name} (have: ${PREVIEW_STATES.map((s) => s.name).join(', ')})`)
      socket.close()
      return
    }

    log(`renderer connected: ${state.name}`)
    let pingTimer = null

    socket.on('message', (raw) => {
      let message
      try {
        message = JSON.parse(raw.toString())
      } catch {
        log('<- unparseable frame')
        return
      }

      if (message.type === 'renderer_health') {
        onHealth?.(message)
        return
      }
      if (message.type !== 'hello') return

      const now = Date.now()
      socket.send(envelope('snapshot', { snapshot: shiftSnapshot(state.snapshot, now) }))
      for (const effect of state.effects) {
        socket.send(envelope('effect', { effect: onNow(effect, now) }))
      }
      log(`-> snapshot + ${String(state.effects.length)} effect(s) for ${state.name}`)

      pingTimer = setInterval(() => {
        socket.send(envelope('ping', {}))
      }, PING_INTERVAL_MS)
    })

    socket.on('close', () => {
      if (pingTimer !== null) clearInterval(pingTimer)
      log('renderer disconnected')
    })
  })

  return {
    server,
    ready: new Promise((resolve) => {
      server.on('listening', () => {
        log(`preview harness listening on ws://127.0.0.1:${String(port)}/ws/renderer?state=<name>`)
        resolve()
      })
    }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve()
        })
      }),
  }
}

if (import.meta.filename === process.argv[1]) {
  const harness = startPreviewServer()
  await harness.ready
}
