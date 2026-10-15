/**
 * Publishing the gateway's catalog into DSH's `llm-pi-ai` settings.
 *
 * DSH reaches a self-hosted OpenAI-compatible endpoint through a provider
 * profile in the `llm-pi-ai` namespace — the same document the Settings →
 * Models → "Custom model API" form writes. This module writes that profile for
 * the gateway, so the models land in the picker without the user filling the
 * form in by hand.
 *
 * Why `ctx.settings.mutate` is the right seam
 * -------------------------------------------
 * `dsh-llm-pi-ai` declares its route table as
 * `z.object({ providers: z.dict(profile).default({}).volatile() })`, and
 * `SettingsForms` accepts a path edit only when it lies under a volatile node
 * (`isVolatilePath`) and refuses an entry with no volatile fields at all. So
 * `providers` is deliberately reachable as a live edit, and the write is the
 * same one the Models page performs. What follows is what makes the models
 * appear, none of it needing a restart:
 *
 *   settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', id], … }])
 *     → ConfigEditor persists into the profile patch
 *     → `loader/volatile-update`
 *     → llm-pi-ai's `ensureRegistrationFacts()`
 *     → `ctx.llm.registerAdapter([…route ids], adapter)`
 *
 * The credential is the other half: the route carries `apiKeyEnv`, a
 * `role('credential-ref')` reference, and the adapter resolves it per request
 * via `ctx.credentials.resolve`. An unresolved reference is a
 * `MISSING_CREDENTIAL` error, which is why the key is stored rather than
 * inlined.
 *
 * Two lanes, one gateway
 * ----------------------
 * The catalog is published as two provider profiles over the same base URL and
 * the same credential reference — a **free** lane (`providerId`) holding the
 * models the gateway advertises as zero-credit, and an **account** lane
 * (`accountProviderId`) holding the rest. The split comes from the gateway's
 * own promotion data (`promo_factor === 0`), falling back to the list price in
 * `credits` when the panel endpoint is unreachable. Unpriced models go to the
 * account lane on purpose: the free lane only ever advertises what the gateway
 * has affirmatively called free. Both lanes are written in one `mutate` call so
 * the picker never shows a half-published split.
 *
 * Field names below are the ones `dsh-llm-pi-ai` actually validates (read from
 * its `Config` schema): a model entry is
 * `{ id, name, contextWindow, maxTokens, input, reasoningEfforts, compat }`
 * and a provider profile is
 * `{ apiKeyEnv, displayName, api, baseURL, models, modelOverrides, compat,
 * defaultContextWindow, defaultMaxTokens, defaultInput, headers, reasoning,
 * thinkingBudgets, cacheRetention, transport, timeoutMs, … }`.
 */

import { panelUrl, providerBaseURL } from './paths.js'

/** Every thinking level `dsh-llm-pi-ai` accepts, in escalation order. */
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

const MODELS_TIMEOUT_MS = 10_000

/**
 * Read one settings namespace from whichever read face the host offers.
 *
 * DSH 0.1.7's `SettingsForms` serves every declared namespace from a single
 * `describe()` call keyed by entry id; the older per-namespace `get(ns)` is
 * still tried for a host that has not moved.
 */
export function readNamespace(settings, ns) {
  if (typeof settings?.describe === 'function') {
    const descriptors = settings.describe()
    if (Array.isArray(descriptors)) {
      for (const descriptor of descriptors) {
        if (descriptor?.ns === ns) return descriptor.value
      }
    }
  }
  if (typeof settings?.get === 'function') return settings.get(ns)
  return undefined
}

/**
 * Pull the numeric multiplier out of the gateway's `credits` string.
 *
 * The field is display text, not a number: the catalogue carries `"x0.00"`,
 * `"x0.59 credits"` and `"x3.33 credits"` for the same concept. Returns null
 * when the string is absent or carries no number, which means *unknown* — not
 * free. Anything unmetered must be advertised as such, never inferred from
 * silence.
 */
export function parseCredits(credits) {
  if (typeof credits !== 'string') return null
  const match = credits.match(/-?\d+(?:\.\d+)?/)
  if (!match) return null
  const value = Number(match[0])
  return Number.isFinite(value) ? value : null
}

/**
 * Is this catalogue entry usable at no cost right now?
 *
 * `credits` is the LIST price; `promo_factor` is the limited-time promotion
 * the WorkBuddy client actually charges (`0` = free now, `0.5` = half price,
 * absent = no machine-readable discount). The promotion wins when present,
 * because a model can be free today on a list price that is not zero, and the
 * reverse. Only an explicit zero counts: an entry with no price data at all
 * goes to the metered lane, where guessing wrong costs a credit rather than
 * quietly overselling a lane as free.
 */
export function isFreeModel(entry) {
  const factor = entry?.promo_factor
  if (typeof factor === 'number') return Number.isFinite(factor) && factor === 0
  return parseCredits(entry?.credits) === 0
}

/**
 * Split the catalogue into the free lane and the metered one.
 *
 * Complementary on purpose: every model lands in exactly one lane, so the
 * picker shows the whole catalogue across the two and neither hides a model.
 */
export function splitCatalog(entries) {
  const free = []
  const account = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (isFreeModel(entry)) free.push(entry)
    else account.push(entry)
  }
  return { free, account }
}


/**
 * Translate the gateway's advertised effort tiers into pi-ai's
 * `reasoningEfforts` map, where the key is the level the picker offers and the
 * value is the spelling sent on the wire as `reasoning_effort`.
 *
 * The gateway's tiers (`low`/`medium`/`high`/`xhigh`/`max`) are already pi-ai
 * level names, so key and value coincide. Unknown spellings are dropped rather
 * than renamed, and `off` is never invented: for these models not thinking is
 * the absence of a parameter the gateway would otherwise default to on, so
 * offering an `off` that does nothing would be a lie in the UI.
 */
export function toReasoningEfforts(supported) {
  if (!Array.isArray(supported)) return undefined
  const efforts = {}
  for (const raw of supported) {
    const level = String(raw ?? '').trim()
    if (!level || level === 'off' || !THINKING_LEVELS.has(level)) continue
    efforts[level] = level
  }
  return Object.keys(efforts).length > 0 ? efforts : undefined
}

/**
 * Normalise one gateway catalogue entry into a pi-ai model entry.
 *
 * The gateway answers with the fields it knows and omits the rest, so every
 * mapping here is conditional — an absent value stays absent rather than
 * becoming a guess. Ids keep the gateway's realm prefix (`cn:` / `global:`),
 * which is what its router expects on the way back in.
 *
 * Two endpoints serve this catalogue and they spell two fields differently:
 * `/v1/models` sends `reasoning_supported_efforts` and `reasoning_default_effort`,
 * the panel sends `supported_efforts` and `default_effort`. Both are read, so
 * either source produces the same entry.
 */
export function toPiAiModel(entry) {
  const id = entry?.id
  if (typeof id !== 'string' || id.length === 0) return null

  const model = {
    id,
    name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id,
  }
  if (Number.isInteger(entry.context_length) && entry.context_length > 0) {
    model.contextWindow = entry.context_length
  }
  if (Number.isInteger(entry.max_output_tokens) && entry.max_output_tokens > 0) {
    model.maxTokens = entry.max_output_tokens
  }
  model.input = entry.supports_images === true ? ['text', 'image'] : ['text']

  const efforts = toReasoningEfforts(entry.reasoning_supported_efforts ?? entry.supported_efforts)
  if (efforts) model.reasoningEfforts = efforts

  return model
}

/**
 * Parse a catalogue reply into pi-ai model entries.
 *
 * Accepts the raw entry array, `/v1/models`' `{ data: [...] }`, or the panel's
 * `{ models: [...] }`, and de-duplicates by id so a repeated entry cannot
 * produce a provider profile pi-ai would reject.
 */
export function toPiAiModels(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : []
  const seen = new Set()
  const models = []
  for (const entry of list) {
    const model = toPiAiModel(entry)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models
}

/**
 * GET the gateway's model catalogue, as raw entries.
 *
 * The panel endpoint is preferred because it is the only one that carries the
 * promotion fields (`promo_factor`, `promo_label`) the free/metered split
 * needs — `/v1/models` advertises list prices only. It is the same process,
 * the same loopback port and the same Bearer key, so the panel is a strictly
 * richer view rather than a second dependency. When it is unavailable the
 * plugin still works, splitting on list prices alone.
 *
 * Throws only when both endpoints fail.
 */
export async function fetchModels(port, apiKey, timeoutMs = MODELS_TIMEOUT_MS) {
  const headers = { authorization: `Bearer ${apiKey}` }
  const errors = []
  for (const url of [`${panelUrl(port)}api/models`, `${providerBaseURL(port)}/models`]) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) {
        errors.push(`${url}: HTTP ${response.status}`)
        continue
      }
      const payload = await response.json()
      const entries = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.models)
          ? payload.models
          : Array.isArray(payload?.data)
            ? payload.data
            : []
      return entries
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(`could not read the model catalogue (${errors.join('; ')})`)
}

/**
 * The request-retry policy both lanes run, in the declared shape
 * `llm-pi-ai`'s `retryPolicy` accepts (`mode`/`maxRetries`/`retryableCodes`,
 * with the backoff nested — the flat `maxRetries`/`maxRetryDelayMs` spelling was
 * removed and is now a hard error).
 *
 * These are `dsh-opencode-router`'s free-lane numbers, kept identical on
 * purpose: the same upstreams sit behind both gateways, so the same patience
 * applies. Worst case per step is 1+2+4+8+16+20+20+20 ≈ 91 s of silent retries.
 * `retryableCodes` mirrors the host default set, so this changes how long a
 * qualifying failure is retried for, not which failures qualify.
 */
export const RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 8,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  backoff: Object.freeze({ initialDelayMs: 1_000, maxDelayMs: 20_000, jitterRatio: 0.2 }),
})

/** The provider profile written into `llm-pi-ai.providers.<providerId>`. */
export function providerRoute(target, models) {
  return {
    displayName: target.displayName ?? 'dsh-workbuddy2dsh',
    apiKeyEnv: target.apiKeyEnv,
    api: 'openai-completions',
    baseURL: providerBaseURL(target.port),
    retryPolicy: RETRY_POLICY,
    models,
  }
}

/**
 * Store the gateway key under the route's credential reference.
 *
 * `credentials.set` is not idempotent in effect: the local provider takes a
 * document lock and rewrites `$DSH_HOME/.credentials.yaml` on every call, even
 * for an unchanged value, and emits `credentials/reference-updated` each time.
 * The refresh loop runs every few minutes, so the previous write is memoized
 * and a repeat of the same pair is skipped.
 *
 * A reference supplied by the launching environment cannot be written at all —
 * the provider rejects the write rather than let it be shadowed into apparent
 * no-effect. That is not a failure: resolution still finds the variable, so the
 * route authenticates. It only breaks if the exported value differs from the
 * gateway's own key, which is worth saying out loud because it surfaces as a
 * bare 401 from every request.
 *
 * @returns `written`, `unchanged`, `shadowed-match`, `shadowed-mismatch`, or
 *   `unsupported`.
 */
export async function publishCredential(seams, ref, value, previous) {
  const credentials = seams.credentials
  if (typeof credentials?.set !== 'function') return 'unsupported'

  // The shadow check runs before the memo on purpose: a reference owned by the
  // launching environment is never written, so there is nothing to memoize,
  // and the exported value can differ between refreshes. Memoizing first would
  // latch the first verdict and hide a later mismatch.
  const info = typeof credentials.describe === 'function' ? await credentials.describe(ref) : undefined
  if (info?.writable === false) {
    const resolved = typeof credentials.resolve === 'function' ? await credentials.resolve(ref) : undefined
    return resolved?.value === value ? 'shadowed-match' : 'shadowed-mismatch'
  }

  if (previous?.ref === ref && previous?.value === value) return 'unchanged'

  await credentials.set(ref, value)
  return 'written'
}

/**
 * Publish (or refresh) the provider routes, in one settings write.
 *
 * One `mutate` for every lane on purpose: each call commits a revision and
 * fires `loader/volatile-update`, so two calls would recompose the route table
 * twice per refresh for no gain. A lane whose model list is empty is skipped by
 * the caller rather than written — an adapter with no models is a provider that
 * appears in the picker and cannot answer.
 *
 * The write touches only `providers.<providerId>` for the lanes given, so a
 * route for another provider — including one the user configured by hand — and
 * every other `llm-pi-ai` setting are left alone. Returns false when the host's
 * settings seam cannot write, or when there is nothing to write.
 *
 * The credential is published separately by {@link publishCredential}: it has
 * different failure modes and a different write cost, and a route whose
 * credential is missing fails as `MISSING_CREDENTIAL` at request time rather
 * than at publish time.
 */
export async function registerProviderLanes(seams, target, lanes) {
  const active = (Array.isArray(lanes) ? lanes : []).filter(
    (lane) => lane?.providerId && Array.isArray(lane.models) && lane.models.length > 0,
  )
  if (active.length === 0) return false

  if (typeof seams.settings?.mutate !== 'function') {
    seams.logger.warn(
      'workbuddy2dsh: the settings seam has no mutate(); the models are not published to the picker',
    )
    return false
  }

  const routes = active.map((lane) => ({
    lane,
    route: providerRoute({ ...target, displayName: lane.displayName }, lane.models),
  }))
  await seams.settings.mutate(
    'llm-pi-ai',
    routes.map(({ lane, route }) => ({ op: 'set', path: ['providers', lane.providerId], value: route })),
  )
  for (const { lane, route } of routes) {
    seams.logger.info(
      `workbuddy2dsh: published ${lane.models.length} model(s) as llm-pi-ai provider ` +
        `"${lane.providerId}" at ${route.baseURL}`,
    )
  }
  return true
}

/**
 * Publish a single lane. A thin wrapper over {@link registerProviderLanes} so
 * the two call sites cannot drift apart.
 */
export function registerProvider(seams, target, models) {
  return registerProviderLanes(seams, target, [
    { providerId: target.providerId, displayName: target.displayName, models },
  ])
}

/** Remove the route this plugin owns. Returns true when one was removed. */
export async function removeProviderRoute(seams, providerId) {
  const namespace = readNamespace(seams.settings, 'llm-pi-ai')
  if (!namespace?.providers || !(providerId in namespace.providers)) return false
  if (typeof seams.settings?.mutate !== 'function') return false
  await seams.settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', providerId] }])
  return true
}
