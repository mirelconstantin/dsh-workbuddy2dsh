/**
 * The chip's readout logic, separated from the component so it can be tested
 * without a DOM.
 *
 * The shape mirrors the bridge's StatusView (src/bridge.mjs), restated here
 * rather than imported: the browser bundle must not value-import the node
 * half — it is a different artifact with a different module table.
 */

/** One model, as the chip lists it. Mirrors bridge.mjs. */
export interface ModelRow {
  id: string
  name: string
  credits: string
  promoFactor: number | null
  promoLabel: string
  lane: 'free' | 'account'
}

/** What the bridge answers. Mirrors bridge.mjs. */
export interface StatusView {
  reachable: boolean
  error: string
  panelUrl: string
  pool: { total: number; healthy: number; cooling: number; disabled: number }
  freeModels: ModelRow[]
  accountModels: ModelRow[]
  creditsSpent: number
  at: number
}

/**
 * What the chip renders.
 *
 * There is deliberately no "absent" member. A chip that vanishes when the
 * gateway is down would remove the only control that says *why* — the reader
 * needs "not running" far more than they need it gone. `offline` keeps the
 * trigger on screen and names the state, the same reasoning dsh-opencode-router
 * documents for its own chip.
 */
export type ChipState =
  | { mode: 'offline'; error: string }
  | { mode: 'empty' }
  | { mode: 'ready'; freeCount: number; accountCount: number; healthy: number; total: number }

/** What the chip shows for one status reading. */
export function resolve(status: StatusView): ChipState {
  // Not answering at all: the gateway is down, or DSH has not reached it yet.
  if (!status.reachable) return { mode: 'offline', error: status.error }
  // Up, but no account has been linked — the models list is empty and the pool
  // is empty. This is the state a brand-new install sits in, and the chip has
  // to say "add an account" rather than "0 free models", which reads like a
  // broken plugin.
  const models = status.freeModels.length + status.accountModels.length
  if (models === 0 && status.pool.total === 0) return { mode: 'empty' }
  return {
    mode: 'ready',
    freeCount: status.freeModels.length,
    accountCount: status.accountModels.length,
    healthy: status.pool.healthy,
    total: status.pool.total,
  }
}

/** The trigger's short label. */
export function chipValue(state: ChipState, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (state.mode === 'offline') return t('chipValueOffline')
  if (state.mode === 'empty') return t('chipValueEmpty')
  return t('chipValueReady', { free: state.freeCount })
}

/** The tooltip's full sentence. */
export function chipTitle(status: StatusView, state: ChipState, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (state.mode === 'offline') {
    return status.error ? `${t('chipOffline')}: ${status.error}` : t('chipOffline')
  }
  if (state.mode === 'empty') return t('chipEmpty')
  const s = state as { mode: 'ready'; freeCount: number; accountCount: number; healthy: number; total: number }
  return t('chipReady', {
    free: s.freeCount,
    account: s.accountCount,
    healthy: s.healthy,
    total: s.total,
  })
}

/** Health for the trigger's border colour. */
export function chipHealth(state: ChipState): 'ok' | 'bad' | 'flat' {
  if (state.mode === 'ready') return state.healthy > 0 ? 'ok' : 'bad'
  if (state.mode === 'offline') return 'bad'
  // Empty is not unhealthy: a fresh install with no account yet is normal.
  return 'flat'
}

/**
 * A number in the compact form the picker uses: exact below 1k, then K and M.
 * Matches the ConversationMeter's own style so the two dock controls read as
 * one product.
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) {
    const k = value / 1_000
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}K`
  }
  const m = value / 1_000_000
  return `${m >= 100 ? Math.round(m) : Math.round(m * 10) / 10}M`
}

/**
 * A price line for one model, as the panel's catalogue states it.
 *
 * The gateway sends a promotion as a pair — a `promo_factor` multiplier and a
 * human label — and the list price stays what it was. Showing only the factor
 * would hide that a promotion is temporary; showing only the list price would
 * claim a model costs what it did before the promotion started. Both, with the
 * factor struck out, is what the WorkBuddy client itself does.
 */
export function priceLine(row: ModelRow): { current: string; label: string; struck: string | null } {
  if (row.promoFactor === 0) {
    return {
      current: '0.00',
      label: row.promoLabel || 'Free now',
      // The list price is the struck-out figure, when there is one.
      struck: row.credits && parseCreditsNumber(row.credits) !== 0 ? row.credits : null,
    }
  }
  if (row.promoFactor !== null && row.promoFactor > 0) {
    return { current: formatFactor(row.promoFactor), label: row.promoLabel, struck: row.credits || null }
  }
  const numeric = parseCreditsNumber(row.credits)
  return { current: numeric === null ? '—' : formatCredits(numeric), label: '', struck: null }
}

/** The numeric multiplier out of the gateway's `credits` string, or null. */
export function parseCreditsNumber(credits: unknown): number | null {
  if (typeof credits !== 'string') return null
  const match = /-?\d+(?:\.\d+)?/.exec(credits)
  if (!match) return null
  const value = Number(match[0])
  return Number.isFinite(value) ? value : null
}

/** A promotion factor as a price: `0.5` reads as `x0.50`. */
export function formatFactor(factor: number): string {
  return `x${factor.toFixed(2)}`
}

/** A plain multiplier as a price, always two decimals. */
export function formatCredits(value: number): string {
  return value.toFixed(2)
}
