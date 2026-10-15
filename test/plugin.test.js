import assert from 'node:assert/strict'
import { test } from 'node:test'

/**
 * The entry module imports `@deepseek-ai/schemastery`, which the host supplies
 * at runtime and a standalone checkout only has after `npm install`. When it is
 * absent the entry checks are skipped rather than failed, so `npm test` is
 * green on a bare checkout; the module-level checks below run either way.
 */
let mod = null
let importError = null
try {
  mod = await import('../index.js')
} catch (err) {
  importError = err
}

const skip = importError ? `entry not loadable here: ${importError.code ?? importError.message}` : false

test('the entry module is a namespace plugin, never a default export', { skip }, () => {
  // `export default apply` would discard the namespace and crash the plugin on
  // first use (DSH post-mortem 0001), so its absence is asserted, not assumed.
  assert.equal('default' in mod, false)
  assert.equal(mod.name, 'workbuddy2dsh')
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject))
  // Nothing is injected: the gateway must come up even where no settings
  // service is composed.
  assert.deepEqual(mod.inject, [])
})

/**
 * Fields declared `.volatile()` come back from a resolved Config as
 * `Volatile<T>` references, not plain values — that is what makes them
 * live-editable, and it is why every read goes through `.get()`.
 */
const VOLATILE = ['enabled', 'attachOnly', 'binaryPath', 'dataDir', 'port', 'refreshSeconds']

/** Read a resolved Config field, dereferencing a volatile reference. */
function read(resolved, key) {
  const value = resolved[key]
  return value && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
}

test('Config resolves every documented default', { skip }, () => {
  const resolved = mod.Config({})

  assert.deepEqual(
    Object.fromEntries(VOLATILE.map((key) => [key, read(resolved, key)])),
    {
      enabled: true,
      attachOnly: false,
      binaryPath: '',
      dataDir: '',
      port: 7863,
      refreshSeconds: 300,
    },
  )

  // Composition fields are ordinary values, read directly.
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(resolved)
        .filter(([key]) => !VOLATILE.includes(key))
        .map(([key, value]) => [key, value]),
    ),
    {
      // Two lanes: the free lane carries the promo-factor-zero models, the
      // account lane everything else.
      providerId: 'workbuddy2api-free',
      apiKeyEnv: 'WORKBUDDY2DSH_TOKEN',
      displayName: 'WorkBuddy2API Free',
      accountProviderId: 'workbuddy2api-acc',
      accountDisplayName: 'WorkBuddy2API Account',
      restartDelayMs: 1000,
      restartMaxDelayMs: 60000,
      maxConsecutiveCrashes: 5,
      startupTimeoutMs: 30000,
      extraArgs: [],
    },
  )
})

test('a volatile field honours an explicit override', { skip }, () => {
  const resolved = mod.Config({ port: 9000, enabled: false })
  assert.equal(read(resolved, 'port'), 9000)
  assert.equal(read(resolved, 'enabled'), false)
})

test('resolveConfig fills defaults over a partial config', { skip }, () => {
  assert.equal(mod.resolveConfig({ port: 9000 }).port, 9000)
  assert.equal(mod.resolveConfig({ port: 9000 }).providerId, 'workbuddy2api-free')
  assert.equal(mod.resolveConfig({ port: 9000 }).accountProviderId, 'workbuddy2api-acc')
})

test('apply with enabled: false starts nothing and says so', { skip }, async () => {
  const logs = []
  const ctx = {
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    effect: (fn) => {
      globalThis.__dispose = fn()
    },
    on: () => {},
  }

  mod.apply(ctx, { enabled: { get: () => false } })
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.ok(
    logs.some((m) => /disabled by configuration/.test(m)),
    `expected the disabled notice, got: ${JSON.stringify(logs)}`,
  )
  if (typeof globalThis.__dispose === 'function') await globalThis.__dispose()
})

test('the public surface re-exports its helpers', { skip }, () => {
  for (const name of [
    'GatewayRuntime',
    'GatewayProcess',
    'describeAccessDenial',
    'ensureGatewayConfig',
    'generateApiKey',
    'findFreePort',
    'waitForHealth',
    'fetchModels',
    'publishCredential',
    'registerProvider',
    'registerProviderLanes',
    'removeProviderRoute',
    'providerRoute',
    'toPiAiModel',
    'toPiAiModels',
    'toReasoningEfforts',
    'parseCredits',
    'isFreeModel',
    'splitCatalog',
    'defaultBinaryPath',
    'defaultDataDir',
    'panelUrl',
    'providerBaseURL',
    'snapshot',
  ]) {
    assert.ok(name in mod, `missing export ${name}`)
  }
})
