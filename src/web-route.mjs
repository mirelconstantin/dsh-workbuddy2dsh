/**
 * The web route the browser half reads.
 *
 * Registered on DSH's `webServer` service, so the chip can fetch it same-origin
 * from the page it is rendered in — the browser never learns the gateway's API
 * key, and never needs the gateway's port.
 *
 * Trust model, deliberately narrow: DSH's web server binds loopback only, so a
 * request arriving here originated on this machine. The route still refuses a
 * cross-site Origin and any non-loopback Host header, because "loopback" is a
 * property of the socket and not of the request, and a hostile page opened in
 * the user's browser can reach the same socket.
 *
 * It carries no credential of its own and answers with no secret: the pool
 * counts, the catalogue and the panel URL. Nothing here authenticates the
 * caller, so nothing here is worth authenticating.
 */

import { readStatus, BRIDGE_PREFIX } from './bridge.mjs'

/** Cap on any request body, so a stray POST cannot buffer without bound. */
const MAX_BODY_BYTES = 16 * 1024

/** Whether a socket address is a literal loopback peer. */
function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Whether a normalized hostname is a literal loopback authority. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/** Parse a bare Host authority; undefined for anything non-canonical. */
function parseAuthority(authority) {
  if (authority.trim() !== authority) return undefined
  const match = authority.startsWith('[')
    ? /^\[[^\]]+\](?::([0-9]+))?$/.exec(authority)
    : /^[^:@/?#\s]+(?::([0-9]+))?$/.exec(authority)
  if (!match) return undefined
  try {
    const url = new URL(`http://${authority}`)
    if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      return undefined
    }
    const rawPort = match[1]
    if (rawPort !== undefined && (String(Number(rawPort)) !== rawPort || Number(rawPort) > 65535)) return undefined
    return { url }
  } catch {
    return undefined
  }
}

/** Whether a request may read the status view. */
export function isTrustedRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers?.host
  if (typeof host !== 'string') return false
  const parsed = parseAuthority(host)
  if (!parsed || parsed.url.host.toLowerCase() !== host.toLowerCase()) return false
  // A cross-site Origin means some other page is asking; a same-origin browser
  // request sends no Origin at all for a simple GET.
  const site = request.headers['sec-fetch-site']
  if (site === 'cross-site') return false
  const origin = request.headers.origin
  if (origin !== undefined) {
    try {
      if (new URL(String(origin)).host !== parsed.url.host) return false
    } catch {
      return false
    }
  }
  return isLoopbackHostname(parsed.url.hostname)
}

/** Drain a body without using it, so the socket can be reused. */
async function drain(request) {
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) break
  }
}
function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

/**
 * The route descriptor for `webServer.register`.
 *
 * `read` is how the route reaches the gateway: the runtime passes a function
 * returning the last known port and key, so this module stays free of any
 * dependency on the runtime's own state.
 */
export function bridgeRoute({ port, apiKey }) {
  return {
    kind: 'exact',
    path: `${BRIDGE_PREFIX}/status`,
    handler: async (request, response) => {
      if (!isTrustedRequest(request)) {
        writeJson(response, 403, { error: 'forbidden' })
        return
      }
      // GET only: the route is a read, and a write has nothing to do here.
      if (request.method !== 'GET') {
        await drain(request).catch(() => {})
        writeJson(response, 405, { error: `method not allowed: ${request.method}` })
        return
      }
      try {
        const view = await readStatus(port(), apiKey())
        writeJson(response, 200, view)
      } catch (err) {
        // The gateway being down is the common case and not a route failure:
        // answer with the unreachable view so the chip shows "not running"
        // rather than a transport error in the console.
        writeJson(response, 200, {
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
          at: Date.now(),
        })
      }
    },
  }
}
