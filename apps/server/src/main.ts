import { createServer, DEFAULT_HOST, resolvePort } from './server.js'

const port = resolvePort()
const server = createServer()

server.listen(port, DEFAULT_HOST, () => {
  process.stdout.write(`@vl/server listening on http://${DEFAULT_HOST}:${port}\n`)
})
