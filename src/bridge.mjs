/**
 * The status bridge: one read-only view of the gateway, for the browser half.
 *
 * The composer-dock chip lives in the web UI and cannot reach the gateway's
 * loopback port directly — the browser is a different process, possibly a
 * different machine, and the gateway binds `127.0.0.1` on purpose. So the
 * plugin's own fiber reads the gateway over loopback and republishes what the
 * chip needs through a DSH web route, same-origin, guarded exactly like the
 * sidecar it describes.
 *
 * Why a bridge and not three direct calls from the browser: the chip would have
 * to carry the gateway's API key in the page, and every panel endpoint answers
 * on a different shape. One route, one shape, one place where the key lives.
 *
 * The trust model is the loopback guard the runtime already relies on (see
 * `src/health.js`): DSH's web server only binds loopback, so a request that
 * reaches here came from this machine. The route carries no credentials of its
 * own — it answers with the gateway's public catalogue and pool counts, never
 * a token — so an accidental cross-origin read costs nothing but a status
 * glance. See `src/bridge.mjs` for the guard itself.
 */

import { panelUrl } from './paths.js'

/** The DSH web route the chip polls. Same-origin, no key in the page. */
export const BRIDGE_PREFIX = '/api/workbuddy2dsh'

/**
 * Everything the chip renders, from one read.
 *
 * A model row carries the gateway's own pricing fields verbatim: `credits` is
 * the list price ("x0.79"), `promoFactor`/`promoLabel` the promotion currently
 * in force, and `lane` the free/account split this plugin already publishes.
 * `reachable` is separate from every count on purpose — a gateway that is up
 * with no accounts is a different situation from one that is not up, and
 * collapsing them would read "0 of 0 usable" during a restart.
 */

/** Empty pool counts, for a gateway that is not answering. */
function emptyPool() {
  return { total: 0, healthy: 0, cooling: 0, disabled: 0 }
}

/** An unreachable view. Keeps the last panel URL so the chip stays actionable. */
export function unreachableView(port, error = '') {
  return {
    reachable: false,
    error,
    panelUrl: port > 0 ? panelUrl(port) : '',
    pool: emptyPool(),
    freeModels: [],
    accountModels: [],
    creditsSpent: 0,
    at: Date.now(),
  }
}

/** The numeric multiplier out of the gateway's `credits` string, or null. */
export function parseCredits(credits) {
  if (typeof credits !== 'string') return null
  const match = /-?\d+(?:\.\d+)?/.exec(credits)
  if (!match) return null
  const value = Number(match[0])
  return Number.isFinite(value) ? value : null
}

/** The same free/account rule the runtime publishes with — see src/provider.js. */
export function laneOf(entry) {
  const factor = entry?.promo_factor
  if (typeof factor === 'number' && Number.isFinite(factor)) return factor === 0 ? 'free' : 'account'
  return parseCredits(entry?.credits) === 0 ? 'free' : 'account'
}

/** Normalise one panel model entry into the chip's row shape. */
function toModelRow(entry, lane) {
  const id = typeof entry.id === 'string' ? entry.id : ''
  const promoFactor = typeof entry.promo_factor === 'number' ? entry.promo_factor : null
  return {
    id,
    name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id,
    credits: typeof entry.credits === 'string' ? entry.credits : '',
    promoFactor,
    promoLabel: typeof entry.promo_label === 'string' ? entry.promo_label : '',
    lane,
  }
}

/** The model list, as raw entries, from either endpoint's shape. */
function modelEntries(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.models)) return payload.models
  if (Array.isArray(payload?.data)) return payload.data
  return []
}

/**
 * Build the view by reading the gateway's panel over loopback.
 *
 * Three endpoints, because no single one carries the whole answer:
 * `/panel/api/overview` for pool health, `/panel/api/models` for the catalogue
 * (the only endpoint carrying `promo_factor`), and `/panel/api/usage` for what
 * has actually been spent. Each degrades on its own: a catalogue that cannot be
 * read still leaves the chip with a pool count and a working panel link.
 */
export async function readStatus(port, apiKey, timeoutMs = 8000) {
  if (!(port > 0)) return unreachableView(port, 'the gateway has no port yet')

  const headers = { authorization: `Bearer ${apiKey}` }
  const base = `http://127.0.0.1:${port}`
  const get = async (path) => {
    const response = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
    return response.json()
  }

  let overview = {}
  let modelsPayload = null
  let usagePayload = {}
  let error = ''

  // The catalogue is the one field worth tolerating failure on: right after the
  // gateway boots the pool is empty and /panel/api/models answers 503 while
  // the first account loads. Every endpoint degrades on its own.
  const results = await Promise.all([
    get('/panel/api/overview').catch((err) => {
      error = err instanceof Error ? err.message : String(err)
      return {}
    }),
    get('/panel/api/models').catch((err) => {
      if (!error) error = err instanceof Error ? err.message : String(err)
      return null
    }),
    get('/panel/api/usage').catch(() => ({})),
  ])
  ;[overview, modelsPayload, usagePayload] = results

  const free = []
  const account = []
  for (const entry of modelEntries(modelsPayload)) {
    const row = toModelRow(entry, laneOf(entry))
    if (!row.id) continue
    // De-duplicate: the panel serves one entry per realm, and an id repeated
    // across realms would otherwise render twice.
    if (row.lane === 'free') {
      if (!free.some((m) => m.id === row.id)) free.push(row)
    } else if (!account.some((m) => m.id === row.id)) {
      account.push(row)
    }
  }

  const totals = usagePayload?.totals ?? {}
  const creditsSpent = typeof totals.credits === 'number' ? totals.credits : 0

  // Reachability is decided by the overview read alone, which is the cheapest
  // and the only one that must succeed for any of this to mean anything. A
  // catalogue that is merely empty (503 while the pool fills) leaves the
  // gateway reachable; a gateway that answers nothing at all does not.
  const reachable = overview !== null && typeof overview === 'object' && Object.keys(overview).length > 0

  return {
    reachable,
    // With no overview there is no pool either, so the counts are zero rather
    // than a real "3 of 5" that the gateway never reported.
    error: reachable ? (modelsPayload === null ? error : '') : error || 'the gateway did not answer',
    panelUrl: panelUrl(port),
    pool: reachable
      ? {
          total: Number(overview.total ?? 0),
          healthy: Number(overview.healthy ?? 0),
          cooling: Number(overview.cooling ?? 0),
          disabled: Number(overview.disabled ?? 0),
        }
      : emptyPool(),
    freeModels: reachable ? free : [],
    accountModels: reachable ? account : [],
    creditsSpent: reachable ? creditsSpent : 0,
    at: Date.now(),
  }
}
