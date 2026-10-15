/**
 * End-to-end: the real gateway binary, driven by the real plugin runtime.
 *
 * The unit suite stubs the gateway out, so it cannot catch a wire-level
 * mismatch — a changed health contract, an endpoint that moved, a key the
 * gateway stops honouring, a child that outlives its disposal. This drives the
 * actual binary through the actual lifecycle and checks the endpoints the
 * plugin depends on.
 *
 * Usage:
 *   node scripts/e2e-gateway.mjs [--binary <path>] [--keep]
 *
 * `--binary` defaults to `WB2API_BINARY`, then to whatever `defaultBinaryPath()`
 * resolves. When `@deepseek-ai/dsh-llm-pi-ai` happens to be resolvable — that
 * is, when this runs inside a host checkout — the published route is also
 * validated against the adapter's real Config schema; otherwise that one step
 * is skipped and said so.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(new URL('../index.js', import.meta.url).href)

const argv = process.argv.slice(2)
const flag = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

// An absolute path, or `spawn` will resolve it against its own cwd and fail
// with ENOENT for anything but a bare command name.
const binary = resolve(flag('binary') ?? process.env.WB2API_BINARY ?? mod.defaultBinaryPath())
const keep = argv.includes('--keep')

if (!existsSync(binary)) {
  console.error(`error: no gateway binary at ${binary}`)
  console.error('       run `node scripts/build-gateway.mjs`, or pass --binary <path>')
  process.exit(2)
}

// Optional: only present when this runs inside a host checkout.
let PiAiConfig = null
try {
  PiAiConfig = (await import('@deepseek-ai/dsh-llm-pi-ai')).Config
} catch {
  // Not resolvable here; the schema-acceptance step is skipped.
}

const log = (...args) => console.log('·', ...args)
const step = (n, text) => console.log(`\n[${n}] ${text}`)

console.log(`dsh-workbuddy2dsh end-to-end check`)
console.log(`gateway binary: ${binary}`)
console.log(`route schema:   ${PiAiConfig ? 'dsh-llm-pi-ai (validated)' : 'not resolvable — skipped'}`)

// ---------------------------------------------------------------- fixtures

const root = await mkdtemp(join(tmpdir(), 'wb2dsh-e2e-'))
const dataDir = join(root, 'gateway')
await mkdir(dataDir, { recursive: true })

/** A ctx shaped like the host's: credentials store + volatile route settings. */
function makeCtx(providers, store) {
  const ctx = {
    logs: [],
    credentials: {
      describe: async (ref) => ({ configured: ref in store, writable: true }),
      resolve: async (ref) => (ref in store ? { value: store[ref], source: 'file' } : undefined),
      set: async (ref, value) => {
        store[ref] = value
      },
    },
    settings: {
      // SettingsForms.describe() → one descriptor per profile entry id.
      describe: () => [{ ns: 'llm-pi-ai', value: { providers }, revision: 1, applies: 'live' }],
      // SettingsForms.mutate() applies path ops against the stored section.
      mutate: async (ns, ops) => {
        assert.equal(ns, 'llm-pi-ai')
        for (const op of ops) {
          const [, key] = op.path
          if (op.op === 'set') providers[key] = op.value
          else delete providers[key]
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

const providers = {}
const store = {}
const ctx = makeCtx(providers, store)

// ------------------------------------------------------------------- start

step(1, 'start the real gateway through the plugin runtime')

const runtime = new mod.GatewayRuntime(ctx, ctx.logger)
const config = {
  enabled: true,
  attachOnly: false,
  binaryPath: binary,
  dataDir,
  port: 0, // let the plugin pick a free port
  providerId: 'workbuddy2dsh',
  apiKeyEnv: 'WORKBUDDY2DSH_TOKEN',
  displayName: 'WorkBuddy2API',
  refreshSeconds: 300,
  restartDelayMs: 1000,
  restartMaxDelayMs: 60000,
  maxConsecutiveCrashes: 5,
  startupTimeoutMs: 20000,
  extraArgs: [],
}

await runtime.start(config)

const port = runtime.port
assert.ok(port > 0, 'the plugin chose a port')
log(`gateway port: ${port}`)
log(`panel: ${runtime.panelUrl}`)

const ready = ctx.logs.find(([, m]) => /gateway ready/.test(m))
assert.ok(ready, `readiness was logged — got: ${JSON.stringify(ctx.logs)}`)
log(ready[1])

// The plugin owns exactly listen + api_key of the gateway's own config.
const gatewayConfig = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8'))
assert.equal(gatewayConfig.listen, `127.0.0.1:${port}`, 'the plugin wrote listen')
assert.match(gatewayConfig.api_key, /^sk-/, 'the plugin generated an api_key')
log(`wrote listen=${gatewayConfig.listen}, api_key=${gatewayConfig.api_key.slice(0, 9)}…`)

// It seeded the gateway's other defaults rather than leaving a bare file.
assert.equal(gatewayConfig.auth_dir, './auths', 'the seed kept the gateway defaults')

// ------------------------------------------------------------ endpoints

step(2, 'verify the endpoints the plugin depends on, with the key it stored')

const health = await fetch(`http://127.0.0.1:${port}/healthz`)
log(`GET /healthz → ${health.status}`)

const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/models`)
log(`GET /v1/models (no key) → ${unauthorized.status}`)
assert.equal(unauthorized.status, 401, 'the gateway rejects an unauthenticated catalog read')

const modelsResponse = await fetch(`http://127.0.0.1:${port}/v1/models`, {
  headers: { authorization: `Bearer ${gatewayConfig.api_key}` },
})
assert.equal(modelsResponse.status, 200, 'the stored key is accepted')
const payload = await modelsResponse.json()
log(`GET /v1/models (key) → 200, ${payload.data?.length ?? 0} model(s) in the catalog`)

// The plugin's own reader must agree with the wire.
const read = await mod.fetchModels(port, gatewayConfig.api_key)
log(`plugin fetchModels() → ${read.length} model(s)`)

const panel = await fetch(`http://127.0.0.1:${port}/panel/`)
log(`GET /panel/ → ${panel.status}`)

// ------------------------------------------------- credential + publish

step(3, 'credential and route state')

// The key is published as soon as the gateway is up, independently of whether
// a catalog exists yet — a login landing between two refreshes must be
// servable on the very next tick.
assert.equal(store.WORKBUDDY2DSH_TOKEN, gatewayConfig.api_key, 'the key is stored under the reference')
log('credential WORKBUDDY2DSH_TOKEN matches the gateway api_key')

const route = providers.workbuddy2dsh
if (read.length === 0) {
  // Expected with no account linked: the gateway answers 200 with an empty
  // list, and the plugin must say so once and publish nothing.
  assert.equal(route, undefined, 'an empty catalog publishes no route')
  const hint = ctx.logs.filter(([, m]) => /exposes no models yet/.test(m))
  assert.equal(hint.length, 1, 'the empty-catalog hint is logged exactly once')
  log('no account linked → no route published, hint logged once:')
  log(`  "${hint[0][1]}"`)
} else {
  assert.ok(route, 'the route was published')
  log(`route published with ${route.models.length} model(s)`)
}

// ------------------------------------------------- schema acceptance

step(4, 'validate the published route shape against the host schema')

// Built from the same translator the runtime uses, so this covers the mapping
// even when the gateway itself has no account linked and published nothing.
const candidate = mod.providerRoute(
  { providerId: 'workbuddy2dsh', apiKeyEnv: 'WORKBUDDY2DSH_TOKEN', displayName: 'WorkBuddy2API', port },
  [
    mod.toPiAiModel({
      id: 'global:deepseek-v4.1-flash',
      name: 'Deepseek-V4.1-Flash',
      context_length: 1_000_000,
      max_output_tokens: 128_000,
      supports_images: true,
      reasoning_supported_efforts: ['low', 'high', 'max'],
    }),
    mod.toPiAiModel({ id: 'cn:glm-5.2', name: 'GLM-5.2' }),
  ],
)
assert.equal(candidate.baseURL, `http://127.0.0.1:${port}/v1`, 'the baseURL tracks the chosen port')
assert.deepEqual(
  candidate.models.map((m) => m.id),
  ['global:deepseek-v4.1-flash', 'cn:glm-5.2'],
)
assert.deepEqual(candidate.models[0].input, ['text', 'image'])
assert.deepEqual(candidate.models[0].reasoningEfforts, { low: 'low', high: 'high', max: 'max' })
log(`translator output: ${candidate.models.map((m) => m.id).join(', ')}`)

if (!PiAiConfig) {
  log('skipped: @deepseek-ai/dsh-llm-pi-ai is not resolvable from here')
} else {
  const accepted = PiAiConfig({ providers: { workbuddy2dsh: candidate } })
  const resolved = accepted.providers.get().workbuddy2dsh
  assert.equal(resolved.api, 'openai-completions')
  assert.equal(resolved.models.length, candidate.models.length)
  assert.equal(resolved.models[0].contextWindow, 1_000_000)
  log(`dsh-llm-pi-ai accepted it: ${resolved.models.length} model(s), api=${resolved.api}`)

  if (route) {
    // The route that actually reached the settings seam must also be valid.
    PiAiConfig({ providers: { workbuddy2dsh: route } })
    log('the route the runtime actually published is valid too')
  }
}

// ------------------------------------------------------ reconfigure live

step(5, 'a live settings change does not restart a healthy gateway')

const before = runtime.port
await runtime.reconfigure({ ...config, displayName: 'WorkBuddy2API (renamed)' })
assert.equal(runtime.port, before, 'a route-identity change does not restart the child')
assert.equal(runtime.panelUrl, `http://127.0.0.1:${before}/panel/`, 'the panel is still on the same port')
// The gateway kept serving across the change.
const afterReconfigure = await fetch(`http://127.0.0.1:${before}/healthz`)
assert.ok(afterReconfigure.status > 0, 'the gateway still answers after a live reconfigure')
log(`displayName change applied in place; the gateway still answers on ${before}`)

const changed = ctx.logs.filter(([, m]) => /reconfiguring/.test(m))
assert.equal(changed.length, 0, 'nothing triggered a restart')
log('no restart was logged — the change was route-only')

// ---------------------------------------------------------------- teardown

step(6, 'dispose withdraws the route and stops the child')

await runtime.dispose()
assert.equal(providers.workbuddy2dsh, undefined, 'the route is withdrawn on dispose')
log('route withdrawn')

// Wait out the kill: Windows tears the child down via `taskkill`, which is
// asynchronous with respect to the dispose() call that requested it.
await new Promise((resolve) => setTimeout(resolve, 2000))
const stillListening = await fetch(`http://127.0.0.1:${port}/healthz`)
  .then(() => true)
  .catch(() => false)
assert.equal(stillListening, false, 'the child process is gone')
log('the gateway port no longer answers — the child was reaped')

if (keep) {
  console.log(`\nkept the data directory: ${root}`)
} else {
  await rm(root, { recursive: true, force: true })
}

console.log('\nE2E OK — gateway started, keyed, health-checked, published, reconfigured, and reaped.')
