#!/usr/bin/env node
/**
 * Screenshots the six representative states of TASK_SPECS §T14 acceptance 1 and
 * measures the sustained frame rate at 1080x1920.
 *
 * It drives the real build in a real browser over a real WebSocket: the built
 * `dist/` is served over loopback, `preview-server.mjs` plays one preview state,
 * and Chrome is driven through the DevTools protocol with the `ws` client the
 * harness already depends on — no new dependency, no headless browser framework.
 *
 *   npm run build -w @vl/contract && npm run build -w @vl/renderer
 *   node apps/renderer/scripts/capture.mjs
 *
 * Options: `--out <dir>` `--measure-ms <n>` `--settle-ms <n>` `--keep-open`.
 * `VL_CHROME` overrides the browser path.
 *
 * The frame rate it reports is measured inside a headless browser, whose
 * compositor and (software) WebGL are not the OBS host's. It shows that the
 * renderer's frame loop keeps up at broadcast resolution; it is not a
 * measurement of the production encoder path.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { WebSocket } from 'ws'

import { PREVIEW_STATES } from '../src/testing/preview-states.ts'
import { startPreviewServer } from './preview-server.mjs'

const RENDERER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(RENDERER_ROOT, '..', '..')

const STAGE_WIDTH = 1080
const STAGE_HEIGHT = 1920
const STATIC_PORT = 5199
const WS_PORT = Number(process.env.VL_PORT ?? '8787')
const CDP_PORT = 9333

const CHROME_CANDIDATES = [
  process.env.VL_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
}

function parseArgs(argv) {
  const options = {
    out: join(REPO_ROOT, 'docs', 'tasks', 'assets'),
    measureMs: 20_000,
    settleMs: 2_500,
    keepOpen: false,
    // Which preview states to shoot, and how the files are named. Both default
    // to the T14 run that produced the six original screenshots, so re-shooting
    // one state for a later task does not overwrite or rename the rest.
    only: null,
    prefix: 'TASK-T14',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--out') options.out = resolve(argv[++index])
    else if (flag === '--measure-ms') options.measureMs = Number(argv[++index])
    else if (flag === '--settle-ms') options.settleMs = Number(argv[++index])
    else if (flag === '--keep-open') options.keepOpen = true
    else if (flag === '--only') options.only = new Set(argv[++index].split(','))
    else if (flag === '--prefix') options.prefix = argv[++index]
  }
  return options
}

function sleep(ms) {
  return new Promise((resolve_) => setTimeout(resolve_, ms))
}

function serveDist(root, port) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const relative = url.pathname === '/' ? '/index.html' : url.pathname
    const file = normalize(join(root, relative))
    if (!file.startsWith(root) || !existsSync(file)) {
      response.writeHead(404).end('not found')
      return
    }
    response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    response.end(readFileSync(file))
  })
  return new Promise((resolve_) => {
    server.listen(port, '127.0.0.1', () => {
      resolve_(server)
    })
  })
}

/** The smallest DevTools protocol client that can drive a page. */
class Cdp {
  #socket
  #nextId = 1
  #pending = new Map()

  constructor(socket) {
    this.#socket = socket
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString())
      if (message.id === undefined) return
      const entry = this.#pending.get(message.id)
      if (entry === undefined) return
      this.#pending.delete(message.id)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    })
  }

  static async connect(url) {
    const socket = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 })
    await new Promise((resolve_, reject) => {
      socket.once('open', resolve_)
      socket.once('error', reject)
    })
    return new Cdp(socket)
  }

  send(method, params = {}) {
    const id = this.#nextId
    this.#nextId += 1
    return new Promise((resolve_, reject) => {
      this.#pending.set(id, { resolve: resolve_, reject })
      this.#socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    this.#socket.close()
  }
}

async function findPageTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/list`)
      const targets = await response.json()
      const page = targets.find((target) => target.type === 'page')
      if (page !== undefined) return page.webSocketDebuggerUrl
    } catch {
      // Chrome is still starting.
    }
    await sleep(250)
  }
  throw new Error('chrome did not expose a page target')
}

function launchChrome() {
  const binary = CHROME_CANDIDATES.find(
    (candidate) => candidate !== undefined && existsSync(candidate),
  )
  if (binary === undefined) throw new Error('no chrome found; set VL_CHROME')
  const profile = mkdtempSync(join(tmpdir(), 'vl-capture-'))
  const child = spawn(
    binary,
    [
      '--headless=new',
      `--remote-debugging-port=${String(CDP_PORT)}`,
      `--user-data-dir=${profile}`,
      `--window-size=${String(STAGE_WIDTH)},${String(STAGE_HEIGHT)}`,
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      // Software WebGL: this host runs the capture without a GPU context.
      '--enable-unsafe-swiftshader',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  return { child, binary }
}

function pageUrl(stateName, mode = 'dev') {
  const ws = encodeURIComponent(`ws://127.0.0.1:${String(WS_PORT)}/ws/renderer?state=${stateName}`)
  return `http://127.0.0.1:${String(STATIC_PORT)}/?mode=${mode}&ws=${ws}`
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true })
  return result.result?.value
}

async function waitForScreen(cdp, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ready = await evaluate(
      cdp,
      `Boolean(document.querySelector('[data-testid="hud"], [data-testid="interaction-paused"]'))`,
    )
    if (ready === true) return
    if (Date.now() > deadline) throw new Error('the screen did not render in time')
    await sleep(250)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const dist = join(RENDERER_ROOT, 'dist')
  if (!existsSync(join(dist, 'index.html'))) {
    throw new Error('apps/renderer/dist is missing; run `npm run build -w @vl/renderer` first')
  }
  mkdirSync(options.out, { recursive: true })

  const health = []
  const staticServer = await serveDist(dist, STATIC_PORT)
  const harness = startPreviewServer({
    port: WS_PORT,
    log: () => {},
    onHealth: (message) => {
      health.push({ at: Date.now(), frameCounter: message.frameCounter, fps: message.fps })
    },
  })
  await harness.ready

  const { child, binary } = launchChrome()
  const cdp = await Cdp.connect(await findPageTarget())
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: STAGE_WIDTH,
    height: STAGE_HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  })

  console.log(`chrome: ${binary}`)
  const written = []
  // The acceptance criterion asks for `?mode=dev`; `?mode=broadcast` is captured
  // for one state as well, because that is the screen OBS actually opens.
  const broadcastNames = new Set(['calm', 'paid-thanks'])
  const selected = PREVIEW_STATES.filter(
    (state) => options.only === null || options.only.has(state.name),
  )
  if (selected.length === 0) {
    throw new Error(`--only matched no preview state (have: ${PREVIEW_STATES.map((s) => s.name)})`)
  }
  const shots = [
    ...selected.map((state) => ({ state, mode: 'dev' })),
    ...selected
      .filter((state) => broadcastNames.has(state.name))
      .map((state) => ({ state, mode: 'broadcast' })),
  ]
  for (const { state, mode } of shots) {
    await cdp.send('Page.navigate', { url: pageUrl(state.name, mode) })
    await waitForScreen(cdp)
    await sleep(options.settleMs)

    const measured = await evaluate(
      cdp,
      `(() => { const s = document.querySelector('[data-testid="stage"]').getBoundingClientRect();
                const c = document.querySelector('canvas');
                return \`stage \${s.width}x\${s.height}, canvas \${c ? c.width + 'x' + c.height : 'none'}, slots \${document.querySelectorAll('.slot').length}\`; })()`,
    )

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = join(options.out, `${options.prefix}-${mode}-${state.name}-1080x1920.png`)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    written.push(file)
    console.log(`${mode}/${state.name}: ${measured} -> ${file}`)
  }

  // Frame budget (TASK_SPECS §T14 "성능"): the frame counter is reported by the
  // renderer itself in `renderer_health`, so this divides real frames by a real
  // wall clock rather than trusting the browser's own FPS number.
  health.length = 0
  await cdp.send('Page.navigate', { url: pageUrl('play') })
  await waitForScreen(cdp)
  await sleep(options.measureMs)
  const first = health[0]
  const last = health[health.length - 1]
  if (first !== undefined && last !== undefined && last.at > first.at) {
    const seconds = (last.at - first.at) / 1_000
    const frames = last.frameCounter - first.frameCounter
    console.log(
      `frame budget: ${String(frames)} frames in ${seconds.toFixed(1)}s = ` +
        `${(frames / seconds).toFixed(1)} fps at ${String(STAGE_WIDTH)}x${String(STAGE_HEIGHT)} ` +
        `(headless, software WebGL; ${String(health.length)} health frames)`,
    )
  } else {
    console.log('frame budget: no renderer_health frames arrived')
  }

  if (!options.keepOpen) {
    cdp.close()
    child.kill()
    await harness.close()
    staticServer.close()
  }
  console.log(`wrote ${String(written.length)} screenshots to ${options.out}`)
}

await main()
