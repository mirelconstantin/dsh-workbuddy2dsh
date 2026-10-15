/**
 * Networking helpers: a free-port probe and the readiness poll.
 *
 * The gateway has no READY-line handshake (unlike the opencode sidecar agent),
 * so readiness is "the listener answers `/healthz`". Any HTTP status counts:
 * the endpoint replies 503 while the account pool is empty, and that is a
 * perfectly healthy gateway waiting for a login.
 */

import { createServer } from 'node:net'

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Ask the OS for a free loopback port. */
export function findFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, host, () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? resolve(port) : reject(new Error('could not determine a free port'))))
    })
  })
}

/**
 * Poll `/healthz` until the gateway answers, or fail with the last transport
 * error so the log says *why* it never came up.
 */
export async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no response yet'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(2000),
      })
      return { status: response.status, body: await response.json().catch(() => null) }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await delay(250)
  }
  throw new Error(`gateway did not answer /healthz within ${timeoutMs}ms (${lastError})`)
}

/** Is a TCP port on loopback already accepting connections? */
export function isPortBusy(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(true))
    probe.once('listening', () => probe.close(() => resolve(false)))
    probe.listen(port, host)
  })
}
