import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { GatewayRuntime, describeAccessDenial, readVolatile, snapshot } from '../src/runtime.js'

const API_KEY = 'sk-runtime-test'

/**
 * A stand-in for the gateway: /healthz, an OpenAI-shaped /v1/models, and the
 * panel's /panel/api/models.
 *
 * The runtime prefers the panel endpoint because it is the only one carrying
 * the promotion fields the free/metered split reads. `panel: false` models a
 * gateway whose panel is unreachable, which must still work off list prices.
 *
 * The stub answers `Connection: close`, because the runtime reaches it with
 * the global `fetch`, whose dispatcher pools keep-alive sockets. A pooled
 * socket outlives the server and holds the test runner's event loop open for
 * as long as it lingers, so the runner would pass every assertion and then
 * hang. Sockets are tracked and destroyed on close for the same reason.
 */
function startStubGateway({ models = [], requireKey = true, panel = true } = {}) {
  const sockets = new Set()
  // The served catalogue is replaceable, so a test can stand a promotion
  // expiring between two refreshes without starting a second gateway.
  let served = models
  const server = createServer((req, res) => {
    res.setHeader('connection', 'close')
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ healthy: 1, total: served.length > 0 ? 1 : 0, service: 'workbuddy2api' }))
      return
    }
    const keyed = !requireKey || req.headers.authorization === `Bearer ${API_KEY}`
    if (req.url === '/panel/api/models' && panel) {
      if (!keyed) {
        res.writeHead(401).end('unauthorized')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: served }))
      return
    }
    if (req.url === '/v1/models') {
      if (!keyed) {
        res.writeHead(401).end('unauthorized')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: served }))
      return
    }
    res.writeHead(404).end()
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        setModels: (next) => {
          served = next
        },
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy()
            sockets.clear()
            server.close(() => done())
          }),
      })
    })
  })
}

/**
 * A ctx good enough for the runtime: logger, credentials, settings.
 *
 * `ctx.writes` records every credential store, and `credentialInfo` /
 * `credentialValue` stand in for a reference the launching environment owns —
 * the one case `credentials.set` refuses.
 */
function fakeCtx(providers) {
  const ctx = {
    logs: [],
    writes: [],
    credentialInfo: undefined,
    credentialValue: undefined,
    credentials: {
      describe: async () => ctx.credentialInfo ?? { configured: false, writable: true },
      resolve: async () =>
        ctx.credentialValue === undefined ? undefined : { value: ctx.credentialValue, source: 'env' },
      set: async (ref, value) => {
        ctx.writes.push({ ref, value })
        providers.key = { ref, value }
      },
    },
    settings: {
      describe: () => [{ ns: 'llm-pi-ai', value: { providers } }],
      mutate: async (_ns, ops) => {
        for (const op of ops) {
          if (op.op === 'set') providers[op.path[1]] = op.value
          else delete providers[op.path[1]]
        }
      },
    },
  }
  ctx.logger = {
    info: (m) => ctx.logs.push(['info', m]),
    warn: (m) => ctx.logs.push(['warn', m]),
    error: (m) => ctx.logs.push(['error', m]),
  }
  return ctx
}

const CATALOG = [
  {
    id: 'global:deepseek-v4.1-flash',
    name: 'Deepseek-V4.1-Flash',
    context_length: 1_000_000,
    max_output_tokens: 128_000,
    credits: 'x0.00',
    promo_factor: 0,
    promo_label: 'Free now',
    reasoning_supported_efforts: ['high'],
  },
  { id: 'cn:glm-5.2', name: 'GLM-5.2', credits: 'x0.79' },
]

/** The ids the free and metered lanes carry, for the fixture above. */
const FREE_IDS = ['global:deepseek-v4.1-flash']
const METERED_IDS = ['cn:glm-5.2']

/** True when neither lane has a route in the fake settings document. */
function noRoutes(providers) {
  return (
    providers['workbuddy2api-free'] === undefined && providers['workbuddy2api-acc'] === undefined
  )
}

/**
 * The same seams, reachable ONLY through `ctx.inject()`.
 *
 * Cordis hands a service to a context only when that fiber asked for it: a
 * plain `ctx.credentials` on a fiber whose `inject` is empty THROWS
 * (`cannot get property "credentials" without inject`) rather than answering
 * `undefined`. The first version of this runtime read both seams straight off
 * the context, so that throw flew into `refresh()`'s catch-all and the entire
 * publish half went silent — no credential, no route, and no error worth
 * reading. `fakeCtx` could not catch that because it exposes the services as
 * ordinary properties; this ctx reproduces the refusal.
 */
function cordisLikeCtx(providers, { omit = [] } = {}) {
  const plain = fakeCtx(providers)
  const services = { credentials: plain.credentials, settings: plain.settings }
  for (const name of omit) delete services[name]
  delete plain.credentials
  delete plain.settings
  plain.inject = (names, callback) => {
    const child = {}
    for (const name of names) child[name] = services[name]
    // Cordis fires the callback once the dependencies are up, never
    // synchronously with the call that asked for them.
    setTimeout(() => callback(child), 0)
    return Promise.resolve()
  }
  return new Proxy(plain, {
    get: (target, prop, receiver) => {
      if (prop === 'credentials' || prop === 'settings') {
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

let root
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb2dsh-rt-'))
})
after(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Seed a data directory with the config.json the gateway would own. */
async function seedDataDir(dirName, apiKey = API_KEY) {
  const dataDir = join(root, dirName)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ api_key: apiKey }), 'utf8')
  return dataDir
}

/**
 * Seed a data directory, start a stub gateway, and build a runtime around
 * both. `models` is what the stub serves; `apiKey` is what its config.json
 * holds.
 */
async function attachCase({ models = CATALOG, dirName, apiKey = API_KEY } = {}) {
  const stub = await startStubGateway({ models })
  const dataDir = await seedDataDir(dirName, apiKey)
  const providers = {}
  const ctx = fakeCtx(providers)
  const runtime = new GatewayRuntime(ctx, ctx.logger)
  return { stub, dataDir, providers, ctx, runtime }
}

const baseConfig = (dataDir, port) => ({
  enabled: true,
  attachOnly: true,
  dataDir,
  port,
  providerId: 'workbuddy2api-free',
  accountProviderId: 'workbuddy2api-acc',
  apiKeyEnv: 'WORKBUDDY2DSH_TOKEN',
  displayName: 'WorkBuddy2API Free',
  accountDisplayName: 'WorkBuddy2API Account',
  refreshSeconds: 300,
  startupTimeoutMs: 8000,
})

test('start publishes both lanes and dispose withdraws them', async () => {
  const { stub, dataDir, providers, runtime } = await attachCase({ dirName: 'a' })
  try {
    await runtime.start(baseConfig(dataDir, stub.port))

    const free = providers['workbuddy2api-free']
    const account = providers['workbuddy2api-acc']
    assert.ok(free, 'the free lane was published')
    assert.ok(account, 'the metered lane was published')

    assert.equal(free.displayName, 'WorkBuddy2API Free')
    assert.equal(account.displayName, 'WorkBuddy2API Account')
    for (const route of [free, account]) {
      assert.equal(route.api, 'openai-completions')
      assert.equal(route.baseURL, `http://127.0.0.1:${stub.port}/v1`)
      assert.equal(route.apiKeyEnv, 'WORKBUDDY2DSH_TOKEN')
    }

    // Complementary, so the two lanes together are still the whole catalogue.
    assert.deepEqual(
      free.models.map((m) => m.id),
      FREE_IDS,
    )
    assert.deepEqual(
      account.models.map((m) => m.id),
      METERED_IDS,
    )
    assert.deepEqual(free.models[0].reasoningEfforts, { high: 'high' })
    assert.deepEqual(providers.key, { ref: 'WORKBUDDY2DSH_TOKEN', value: API_KEY })

    await runtime.dispose()
    assert.ok(noRoutes(providers), 'the routes are gone with the plugin')
  } finally {
    await stub.close()
  }
})

test('startup states the gateway API key and where to change it', async () => {
  // The panel demands this key before it renders anything and nothing else in
  // the UI reveals it, so this log line is the user's only pointer to it — and
  // in attach mode the plugin does not own the file the key came from.
  const { stub, dataDir, ctx, runtime } = await attachCase({ dirName: 'key-log' })
  try {
    await runtime.start(baseConfig(dataDir, stub.port))

    const line = ctx.logs.map(([, message]) => message).find((m) => /gateway API key is/.test(m))
    assert.ok(line, `expected the key notice, got: ${JSON.stringify(ctx.logs)}`)
    assert.ok(line.includes(API_KEY), 'the resolved key is printed')
    assert.ok(line.includes(join(dataDir, 'config.json')), 'and where to change it')
  } finally {
    await runtime.dispose()
    await stub.close()
  }
})

test('an empty catalog still stores the credential', async () => {
  // The key belongs to the gateway, which is already up, so it is published
  // before the catalog is read. A login landing between two refreshes must be
  // servable on the next tick, not one tick later once a route exists.
  const { stub, dataDir, providers, runtime, ctx } = await attachCase({ models: [], dirName: 'i' })
  try {
    await runtime.start(baseConfig(dataDir, stub.port))
    assert.ok(noRoutes(providers), 'no route without a catalog')
    assert.deepEqual(ctx.writes, [{ ref: 'WORKBUDDY2DSH_TOKEN', value: API_KEY }])
  } finally {
    await stub.close()
    await runtime.dispose()
  }
})

test('the seams are reached through ctx.inject when a direct read is refused', async () => {
  const stub = await startStubGateway({ models: CATALOG })
  const dataDir = await seedDataDir('j')
  const providers = {}
  const ctx = cordisLikeCtx(providers)
  const runtime = new GatewayRuntime(ctx, ctx.logger)
  try {
    await runtime.start(baseConfig(dataDir, stub.port))

    assert.deepEqual(
      ctx.writes,
      [{ ref: 'WORKBUDDY2DSH_TOKEN', value: API_KEY }],
      'the gateway key reached the credential store',
    )
    assert.ok(providers['workbuddy2api-free'], 'the free lane was published')
    assert.ok(providers['workbuddy2api-acc'], 'the metered lane was published')
    assert.equal(providers['workbuddy2api-free'].baseURL, `http://127.0.0.1:${stub.port}/v1`)
    assert.deepEqual(
      providers['workbuddy2api-free'].models.map((m) => m.id),
      FREE_IDS,
    )
    assert.deepEqual(
      providers['workbuddy2api-acc'].models.map((m) => m.id),
      METERED_IDS,
    )
  } finally {
    await stub.close()
    await runtime.dispose()
  }
})

test('a missing settings seam still stores the key, and says the route was skipped', async () => {
  // `settings` ships disabled wherever no `profileContext` exists, but the
  // gateway key is still the key every future request resolves. Publishing the
  // route is what needs settings; storing the credential must not wait on it.
  const stub = await startStubGateway({ models: CATALOG })
  const dataDir = await seedDataDir('k')
  const providers = {}
  const ctx = cordisLikeCtx(providers, { omit: ['settings'] })
  const runtime = new GatewayRuntime(ctx, ctx.logger)
  try {
    await runtime.start(baseConfig(dataDir, stub.port))

    assert.deepEqual(ctx.writes, [{ ref: 'WORKBUDDY2DSH_TOKEN', value: API_KEY }])
    assert.ok(noRoutes(providers), 'no route without the settings seam')
    const warns = ctx.logs.filter(([, m]) => /settings service is unavailable/.test(m))
    assert.equal(warns.length, 1, 'the skip is explained exactly once')
  } finally {
    await stub.close()
    await runtime.dispose()
  }
})

test('an empty catalog publishes nothing and says why, once', async () => {
  const { stub, dataDir, providers, runtime, ctx } = await attachCase({ models: [], dirName: 'b' })
  try {
    await runtime.start(baseConfig(dataDir, stub.port))
    assert.ok(noRoutes(providers))

    const hints = ctx.logs.filter(([, m]) => /exposes no models yet/.test(m))
    assert.equal(hints.length, 1)
    assert.match(hints[0][1], /panel/)

    // A second refresh must not repeat the hint.
    await runtime.refresh()
    assert.equal(ctx.logs.filter(([, m]) => /exposes no models yet/.test(m)).length, 1)
  } finally {
    await stub.close()
    await runtime.dispose()
  }
})

test('enabled: false leaves the gateway alone', async () => {
  const { stub, dataDir, providers, runtime } = await attachCase({ dirName: 'c' })
  try {
    await runtime.start({ ...baseConfig(dataDir, stub.port), enabled: false })
    assert.ok(noRoutes(providers))
    assert.equal(runtime.port, 0)
  } finally {
    await stub.close()
  }
})

test('a refresh-interval change only re-arms the timer', async () => {
  const { stub, dataDir, providers, runtime } = await attachCase({ dirName: 'd' })
  try {
    const config = baseConfig(dataDir, stub.port)
    await runtime.start(config)
    const published = providers['workbuddy2api-free']

    const outcome = await runtime.reconfigure({ ...config, refreshSeconds: 60 })
    assert.equal(outcome, 'refresh:refreshSeconds')
    // Same route object identity: nothing was torn down and rebuilt.
    assert.equal(providers['workbuddy2api-free'], published)
  } finally {
    await stub.close()
    await runtime.dispose()
  }
})

test('a provider-id change moves the lane, and leaves the other one alone', async () => {
  const { stub, dataDir, providers, runtime } = await attachCase({ dirName: 'e' })
  try {
    const config = baseConfig(dataDir, stub.port)
    await runtime.start(config)
    assert.ok(providers['workbuddy2api-free'])
    assert.ok(providers['workbuddy2api-acc'])

    const outcome = await runtime.reconfigure({ ...config, providerId: 'workbuddy2' })
    assert.equal(outcome, 'refresh:providerId')
    assert.equal(providers['workbuddy2api-free'], undefined, 'the old lane id is withdrawn')
    assert.ok(providers['workbuddy2'], 'the free lane moved to the new id')
    assert.ok(providers['workbuddy2api-acc'], 'the metered lane is untouched')
    assert.deepEqual(
      providers['workbuddy2'].models.map((m) => m.id),
      FREE_IDS,
    )
  } finally {
    await stub.close()
    await runtime.dispose()
  }
})

test('startup fails loudly when nothing answers /healthz', async () => {
  // No stub: port 1 is reserved and never listening, so /healthz cannot answer.
  const dataDir = await seedDataDir('f')
  const providers = {}
  const ctx = fakeCtx(providers)
  const runtime = new GatewayRuntime(ctx, ctx.logger)
  try {
    await runtime.start({ ...baseConfig(dataDir, 1), startupTimeoutMs: 1500 })
    assert.ok(noRoutes(providers))
    assert.ok(ctx.logs.some(([level, m]) => level === 'error' && /startup failed/.test(m)))
  } finally {
    // A failed readiness check still arms the refresh loop, so the runtime
    // owns a pending timer and must be disposed or the runner never exits.
    await runtime.dispose()
  }
})

test('the credential is written once, then left alone across refreshes', async () => {
  const { stub, dataDir, runtime, ctx } = await attachCase({ dirName: 'g' })
  try {
    const config = baseConfig(dataDir, stub.port)
    await runtime.start(config)
    const writes = () => ctx.writes.length
    assert.equal(writes(), 1, 'the first publish stores the key')

    // `credentials.set` rewrites the store on every call, so a refresh that
    // changes nothing must not call it again.
    await runtime.refresh()
    await runtime.refresh()
    assert.equal(writes(), 1, 'later refreshes reuse the stored pair')
    assert.deepEqual(ctx.writes[0], { ref: 'WORKBUDDY2DSH_TOKEN', value: API_KEY })
  } finally {
    await stub.close()
    await runtime.dispose()
  }
})

test('an environment-supplied credential is reported, not fought over', async () => {
  const { stub, dataDir, runtime, ctx } = await attachCase({ dirName: 'h' })
  try {
    // The launching environment shadows the reference, which is exactly when
    // credentials.set rejects. The route still works while the values agree.
    ctx.credentialInfo = { configured: true, source: 'env', writable: false }
    ctx.credentialValue = API_KEY
    await runtime.start(baseConfig(dataDir, stub.port))

    assert.equal(ctx.writes.length, 0, 'nothing was written')
    assert.ok(ctx.logs.some(([, m]) => /supplied by the environment and matches/.test(m)))

    // A mismatch is the one case worth a warning: it surfaces as a bare 401.
    ctx.credentialValue = 'sk-something-else'
    ctx.logs.length = 0
    await runtime.refresh()
    assert.ok(ctx.logs.some(([level, m]) => level === 'warn' && /does not match/.test(m)))
  } finally {
    await stub.close()
    await runtime.dispose()
  }
})

test('readVolatile accepts both a reference and a plain value', () => {
  assert.equal(readVolatile(5), 5)
  assert.equal(readVolatile({ get: () => 7 }), 7)
  assert.equal(readVolatile(undefined), undefined)
})

test('snapshot dereferences every volatile field', () => {
  assert.deepEqual(snapshot({ a: { get: () => 1 }, b: 'plain' }), { a: 1, b: 'plain' })
  assert.deepEqual(snapshot(undefined), {})
})

test('describeAccessDenial explains an integrity-level denial, and only that', () => {
  // The child's own line is the only evidence a failed startup leaves behind.
  const hint = describeAccessDenial(
    'load config: read config: open D:\\data\\config.json: winapi error #5',
    'C:\\restricted\\wb2api.exe',
    'D:\\data',
  )
  assert.match(hint, /cannot read its own data directory/)
  assert.match(hint, /D:\\data/, 'the denied path is named')
  assert.match(hint, /C:\\restricted\\wb2api\.exe/, 'the binary is named')
  // The remedy must be the one that works unelevated: a copy, not a relabel.
  assert.match(hint, /Copy the binary to a directory outside/)
  assert.doesNotMatch(hint, /setintegritylevel/, 'relabelling needs elevation and is not offered')

  // POSIX spellings are recognised too.
  assert.ok(describeAccessDenial('open /srv/config.json: EACCES', 'b', 'd'))
  assert.ok(describeAccessDenial('permission denied', 'b', 'd'))

  // Anything else stays unexplained rather than mis-explained.
  assert.equal(describeAccessDenial('address already in use', 'b', 'd'), null)
  assert.equal(describeAccessDenial('', 'b', 'd'), null)
  assert.equal(describeAccessDenial(undefined, 'b', 'd'), null)
})

test('a lane that empties out is withdrawn, not left stale', async () => {
  // A promotion expiring empties the free lane. Leaving the route there would
  // keep the picker offering a model the gateway no longer prices as free.
  const { stub, dataDir, providers, runtime } = await attachCase({ dirName: 'g' })
  try {
    await runtime.start(baseConfig(dataDir, stub.port))
    assert.ok(providers['workbuddy2api-free'], 'the free lane starts populated')

    stub.setModels([{ id: 'cn:glm-5.2', name: 'GLM-5.2', credits: 'x0.79' }])
    await runtime.refresh()

    assert.equal(providers['workbuddy2api-free'], undefined, 'the empty lane is withdrawn')
    assert.ok(providers['workbuddy2api-acc'], 'the metered lane is untouched')
  } finally {
    await stub.close()
    await runtime.dispose()
  }
})

test('the catalogue still splits on list prices when the panel is unreachable', async () => {
  // The panel endpoint is the one carrying promotions; when it is not available
  // the plugin must not stop working, it just loses the promotion signal.
  const { stub, dataDir, providers, runtime } = await attachCase({
    models: CATALOG,
    dirName: 'h',
    panel: false,
  })
  try {
    await runtime.start(baseConfig(dataDir, stub.port))

    assert.deepEqual(
      providers['workbuddy2api-free'].models.map((m) => m.id),
      FREE_IDS,
    )
    assert.deepEqual(
      providers['workbuddy2api-acc'].models.map((m) => m.id),
      METERED_IDS,
    )
  } finally {
    await stub.close()
    await runtime.dispose()
  }
})
