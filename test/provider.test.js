import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  isFreeModel,
  parseCredits,
  providerRoute,
  publishCredential,
  readNamespace,
  registerProvider,
  removeProviderRoute,
  splitCatalog,
  toPiAiModel,
  toPiAiModels,
  toReasoningEfforts,
} from '../src/provider.js'

test('toReasoningEfforts keeps pi-ai level names and drops everything else', () => {
  assert.deepEqual(toReasoningEfforts(['low', 'high', 'max']), {
    low: 'low',
    high: 'high',
    max: 'max',
  })
  // The gateway never advertises `off`; inventing one would offer a control
  // that cannot turn thinking off.
  assert.deepEqual(toReasoningEfforts(['off', 'high']), { high: 'high' })
  // Unknown spellings are dropped rather than renamed.
  assert.deepEqual(toReasoningEfforts(['bogus', 'xhigh']), { xhigh: 'xhigh' })
  assert.equal(toReasoningEfforts([]), undefined)
  assert.equal(toReasoningEfforts(undefined), undefined)
  assert.equal(toReasoningEfforts('high'), undefined)
})

test('toPiAiModel maps the gateway fields pi-ai actually validates', () => {
  const model = toPiAiModel({
    id: 'global:deepseek-v4.1-flash',
    name: 'Deepseek-V4.1-Flash',
    context_length: 1_000_000,
    max_output_tokens: 128_000,
    supports_images: false,
    supports_reasoning: true,
    reasoning_supported_efforts: ['high'],
  })
  assert.deepEqual(model, {
    id: 'global:deepseek-v4.1-flash',
    name: 'Deepseek-V4.1-Flash',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    input: ['text'],
    reasoningEfforts: { high: 'high' },
  })
})

test('toPiAiModel omits what the gateway did not send, and never guesses', () => {
  const model = toPiAiModel({ id: 'cn:glm-5.2' })
  assert.deepEqual(model, { id: 'cn:glm-5.2', name: 'cn:glm-5.2', input: ['text'] })
  assert.equal(model.contextWindow, undefined)
  assert.equal(model.reasoningEfforts, undefined)
})

test('toPiAiModel promotes an image-capable model', () => {
  assert.deepEqual(toPiAiModel({ id: 'x', supports_images: true }).input, ['text', 'image'])
})

test('toPiAiModel rejects an entry without a usable id', () => {
  assert.equal(toPiAiModel({ name: 'no id' }), null)
  assert.equal(toPiAiModel({ id: '' }), null)
  assert.equal(toPiAiModel(null), null)
})

test('toPiAiModels de-duplicates by id and tolerates a malformed payload', () => {
  const models = toPiAiModels({
    data: [
      { id: 'a' },
      { id: 'b' },
      { id: 'a' },
      { id: '' },
      null,
      'nonsense',
    ],
  })
  assert.deepEqual(
    models.map((m) => m.id),
    ['a', 'b'],
  )
  assert.deepEqual(toPiAiModels(null), [])
  assert.deepEqual(toPiAiModels({}), [])
  assert.deepEqual(toPiAiModels({ data: 'no' }), [])
})

test('providerRoute uses the openai-completions protocol the gateway speaks', () => {
  const route = providerRoute({ apiKeyEnv: 'K', port: 7863 }, [{ id: 'm' }])
  assert.equal(route.api, 'openai-completions')
  assert.equal(route.baseURL, 'http://127.0.0.1:7863/v1')
  assert.equal(route.apiKeyEnv, 'K')
  assert.equal(route.displayName, 'WorkBuddy2API')
  assert.deepEqual(route.models, [{ id: 'm' }])
})

test('registerProvider writes only its own provider subtree', async () => {
  const writes = []
  const providers = { someoneElse: { api: 'anthropic-messages' } }

  const seams = {
    settings: {
      mutate: async (ns, ops) => {
        writes.push({ ns, ops })
        for (const op of ops) providers[op.path[1]] = op.value
      },
    },
    logger: { info() {}, warn() {} },
  }

  const ok = await registerProvider(
    seams,
    { providerId: 'workbuddy2dsh', apiKeyEnv: 'WORKBUDDY2DSH_TOKEN', port: 7863 },
    [{ id: 'm' }],
  )

  assert.equal(ok, true)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].ns, 'llm-pi-ai')
  assert.deepEqual(writes[0].ops[0].path, ['providers', 'workbuddy2dsh'])
  // The neighbouring provider is untouched.
  assert.deepEqual(providers.someoneElse, { api: 'anthropic-messages' })
  assert.equal(providers.workbuddy2dsh.api, 'openai-completions')
})

test('registerProvider reports failure instead of throwing when the seam cannot write', async () => {
  const warnings = []
  const ok = await registerProvider(
    { settings: {}, logger: { info() {}, warn: (m) => warnings.push(m) } },
    { providerId: 'p', apiKeyEnv: 'K', port: 1 },
    [{ id: 'm' }],
  )
  assert.equal(ok, false)
  assert.match(warnings[0], /no mutate/)
})

test('publishCredential stores a new pair and skips a repeated one', async () => {
  const writes = []
  const seams = {
    credentials: {
      describe: async () => ({ configured: false, writable: true }),
      set: async (ref, value) => writes.push({ ref, value }),
    },
  }

  assert.equal(await publishCredential(seams, 'K', 'sk-1', null), 'written')
  // The credentials provider rewrites its document on every set(), so a
  // repeat of the same pair must not reach it.
  assert.equal(await publishCredential(seams, 'K', 'sk-1', { ref: 'K', value: 'sk-1' }), 'unchanged')
  // A changed value does.
  assert.equal(await publishCredential(seams, 'K', 'sk-2', { ref: 'K', value: 'sk-1' }), 'written')
  assert.deepEqual(writes, [
    { ref: 'K', value: 'sk-1' },
    { ref: 'K', value: 'sk-2' },
  ])
})

test('publishCredential defers to a read-only environment reference', async () => {
  const writes = []
  const info = { configured: true, source: 'env', writable: false }
  const seams = {
    credentials: {
      describe: async () => info,
      resolve: async () => ({ value: 'sk-env', source: 'env' }),
      set: async (ref, value) => writes.push({ ref, value }),
    },
  }

  // Writing would be rejected by the provider, and the environment already
  // supplies the value, so the pair is left alone.
  assert.equal(await publishCredential(seams, 'K', 'sk-env', null), 'shadowed-match')
  // A different exported value is the case worth reporting: every request
  // would come back 401 with nothing else to explain it.
  assert.equal(await publishCredential(seams, 'K', 'sk-other', null), 'shadowed-mismatch')
  assert.deepEqual(writes, [])
})

test('publishCredential reports an absent credentials seam', async () => {
  assert.equal(await publishCredential({}, 'K', 'sk-1', null), 'unsupported')
})

test('readNamespace prefers describe() and falls back to get(ns)', () => {
  const viaDescribe = {
    describe: () => [{ ns: 'other', value: 1 }, { ns: 'llm-pi-ai', value: { providers: { a: 1 } } }],
    get: () => ({ providers: { wrong: true } }),
  }
  assert.deepEqual(readNamespace(viaDescribe, 'llm-pi-ai'), { providers: { a: 1 } })

  const viaGet = { get: (ns) => (ns === 'llm-pi-ai' ? { providers: {} } : undefined) }
  assert.deepEqual(readNamespace(viaGet, 'llm-pi-ai'), { providers: {} })

  assert.equal(readNamespace({}, 'llm-pi-ai'), undefined)
  assert.equal(readNamespace(undefined, 'llm-pi-ai'), undefined)
})

test('removeProviderRoute removes only a route that is there', async () => {
  const providers = { workbuddy2dsh: { api: 'openai-completions' } }
  const seams = {
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', value: { providers } }],
      mutate: async (_ns, ops) => {
        for (const op of ops) delete providers[op.path[1]]
      },
    },
  }

  assert.equal(await removeProviderRoute(seams, 'workbuddy2dsh'), true)
  assert.deepEqual(providers, {})
  assert.equal(await removeProviderRoute(seams, 'workbuddy2dsh'), false)
})

test('parseCredits reads the multiplier out of the display text', () => {
  assert.equal(parseCredits('x0.00'), 0)
  assert.equal(parseCredits('x0.00 credits'), 0)
  assert.equal(parseCredits('x0.59'), 0.59)
  assert.equal(parseCredits('x3.33 credits'), 3.33)
  // An unadvertised price is unknown, not free. Silence must not be read as
  // an invitation to call a lane free.
  assert.equal(parseCredits(undefined), null)
  assert.equal(parseCredits(''), null)
  assert.equal(parseCredits('free'), null)
})

test('isFreeModel prefers the promotion and falls back to the list price', () => {
  // An explicit free promotion wins: a model can be free today on a list price
  // that is not zero.
  assert.equal(isFreeModel({ id: 'a', credits: 'x0.79', promo_factor: 0 }), true)
  // And a partial promotion is not free.
  assert.equal(isFreeModel({ id: 'b', credits: 'x0.79', promo_factor: 0.5 }), false)
  // With no promotion the list price decides.
  assert.equal(isFreeModel({ id: 'c', credits: 'x0.00' }), true)
  assert.equal(isFreeModel({ id: 'd', credits: 'x0.06' }), false)
  // No price data at all is unknown, so it lands in the metered lane.
  assert.equal(isFreeModel({ id: 'e' }), false)
  assert.equal(isFreeModel(undefined), false)
})

test('splitCatalog puts every model in exactly one lane', () => {
  const { free, account } = splitCatalog([
    { id: 'a', promo_factor: 0 },
    { id: 'b', credits: 'x0.00' },
    { id: 'c', credits: 'x0.79' },
    { id: 'd' },
  ])
  assert.deepEqual(free.map((m) => m.id), ['a', 'b'])
  assert.deepEqual(account.map((m) => m.id), ['c', 'd'])
  assert.equal(free.length + account.length, 4, 'complementary, nothing dropped')
  assert.deepEqual(splitCatalog(undefined), { free: [], account: [] })
})

test('toPiAiModels accepts the array, /v1/models and panel spellings alike', () => {
  const shared = { id: 'global:x', name: 'X', context_length: 256000, max_output_tokens: 32000 }
  // /v1/models sends reasoning_supported_efforts...
  const fromV1 = toPiAiModels({ object: 'list', data: [{ ...shared, reasoning_supported_efforts: ['high'] }] })
  // ...the panel sends supported_efforts, and wraps the list in `models`.
  const fromPanel = toPiAiModels({ models: [{ ...shared, supported_efforts: ['high'] }] })
  assert.deepEqual(fromV1, fromPanel)
  assert.deepEqual(fromV1[0].reasoningEfforts, { high: 'high' })
  assert.deepEqual(toPiAiModels([shared]), [toPiAiModel(shared)])
  // A repeated entry cannot produce a duplicate pi-ai would reject.
  assert.equal(toPiAiModels({ data: [{ id: 'y' }, { id: 'y' }] }).length, 1)
})
