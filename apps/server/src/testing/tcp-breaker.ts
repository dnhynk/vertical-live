import { createServer, connect, type Server, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'

/**
 * A loopback TCP relay whose connections can be severed on demand.
 *
 * The chat source has to survive a connection that dies mid-stream without a
 * gRPC status — spec §11 "연결 복구" is about exactly that case — and there is
 * no way to produce it from inside a `@grpc/grpc-js` server: destroying the
 * server-side call sends nothing the client can observe (verified while writing
 * these tests; the client sat there with an open stream). Cutting the socket
 * underneath both ends does produce it, and it is what actually happens on a
 * host that loses its network.
 */
export class TcpBreaker {
  readonly #server: Server
  readonly #sockets = new Set<Socket>()

  private constructor(server: Server) {
    this.#server = server
  }

  static async start(target: string): Promise<TcpBreaker> {
    const [host, port] = splitEndpoint(target)
    const server = createServer()
    const breaker = new TcpBreaker(server)
    server.on('connection', (incoming) => {
      const outgoing = connect(port, host)
      breaker.#sockets.add(incoming)
      breaker.#sockets.add(outgoing)
      incoming.on('close', () => breaker.#sockets.delete(incoming))
      outgoing.on('close', () => breaker.#sockets.delete(outgoing))
      // A severed socket raises ECONNRESET on the other side; nothing here
      // should turn that into an unhandled error event.
      incoming.on('error', () => outgoing.destroy())
      outgoing.on('error', () => incoming.destroy())
      incoming.pipe(outgoing)
      outgoing.pipe(incoming)
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    return breaker
  }

  get endpoint(): string {
    const address = this.#server.address() as AddressInfo
    return `127.0.0.1:${address.port}`
  }

  /** Cuts every live connection, as a network drop would. */
  breakAll(): void {
    for (const socket of this.#sockets) socket.destroy()
    this.#sockets.clear()
  }

  async stop(): Promise<void> {
    this.breakAll()
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve()
      })
    })
  }
}

function splitEndpoint(endpoint: string): [string, number] {
  const index = endpoint.lastIndexOf(':')
  return [endpoint.slice(0, index), Number(endpoint.slice(index + 1))]
}
