/**
 * dsh-workbuddy2dsh — the WorkBuddy2API gateway inside DeepSeek Harness.
 *
 * What this plugin is
 * -------------------
 * WorkBuddy (the international CodeBuddy app) ships DeepSeek V4.1 Flash on a
 * limited-time zero-credit promotion. WorkBuddy2API is a self-hosted gateway
 * that turns a WorkBuddy account into an ordinary OpenAI-compatible `/v1` API
 * and ships a web panel for adding the account and watching the pool. This
 * plugin does not reimplement any of that: it runs the gateway as a **sidecar**
 * and publishes its catalog into DSH's `llm-pi-ai` provider settings, so the
 * models appear in the normal model picker.
 *
 * Unlike `dsh-opencode-router` there is no proxy/exit pool: the gateway talks
 * to the upstream directly, and the only moving part is the child process.
 *
 * Two things happen, in this order
 * --------------------------------
 *  1. The gateway is started unconditionally. It is useful on its own — its
 *     panel is where an account gets added — so the fiber must come up even in
 *     a composition that composes neither `settings` nor `credentials`. That is
 *     also why `inject` is empty and the seams are resolved lazily inside the
 *     runtime.
 *  2. Once `settings` + `credentials` are available, **two** provider routes are
 *     written (`llm-pi-ai.providers.<providerId>` for the free models and
 *     `llm-pi-ai.providers.<accountProviderId>` for the metered ones) and
 *     refreshed together on a timer.
 *
 * Live settings: the fields a user tunes are declared `.volatile()`, so a save
 * from the Plugins page reaches the running gateway without a restart. A change
 * to a connection field restarts the child; a change to either route identity
 * republishes both lanes; a change to the refresh interval only re-arms the
 * timer.
 */

import Schema from '@deepseek-ai/schemastery'

import { GatewayRuntime, snapshot } from './src/runtime.js'

/** Cordis plugin name. The Loader entry id is separate — see cordis.patch.yml. */
export const name = 'workbuddy2dsh'

/**
 * Nothing is injected on purpose.
 *
 * Injecting `settings` would keep the whole fiber dark in a headless
 * composition — DSH composes its settings forms only where a `profileContext`
 * exists — and with it the gateway itself, which is the one part that must
 * always run. The two seams are requested lazily by the runtime instead.
 */
export const inject = []

export const defaults = {
  providerId: 'workbuddy2api-free',
  accountProviderId: 'workbuddy2api-acc',
  apiKeyEnv: 'WORKBUDDY2DSH_TOKEN',
  displayName: 'WorkBuddy2API Free',
  accountDisplayName: 'WorkBuddy2API Account',
  refreshSeconds: 300,
  restartDelayMs: 1000,
  restartMaxDelayMs: 60000,
  maxConsecutiveCrashes: 5,
  startupTimeoutMs: 30000,
}

/**
 * The plugin's settings schema.
 *
 * DSH reads this export to build the editable card in the Plugins page and to
 * learn the field set, so it must be named `Config` on the runtime module.
 * Volatile fields are the live-editable surface; the rest are composition
 * fields a profile sets once.
 */
export const Config = Schema.object({
  /** Start the gateway. Off keeps the plugin loaded but idle. */
  enabled: Schema.boolean().default(true).volatile(),
  /**
   * Attach to a gateway that is already running on `port` instead of spawning
   * one — for a container or a system service that owns the process. The
   * plugin then never writes the gateway's config.json.
   */
  attachOnly: Schema.boolean().default(false).volatile(),
  /** Gateway binary. Blank resolves `bin/wb2api[.exe]`, then `_runtime/`, then PATH. */
  binaryPath: Schema.string().default('').volatile(),
  /** Directory holding config.json / auths / data. Blank resolves `~/.workbuddy2dsh`. */
  dataDir: Schema.string().default('').volatile(),
  /** Loopback port. `0` picks a free one at startup. */
  port: Schema.number().step(1).min(0).max(65535).default(7863).volatile(),
  /** Model-list refresh interval, seconds, once the catalog is populated. */
  refreshSeconds: Schema.number().step(1).min(5).default(defaults.refreshSeconds).volatile(),
  /**
   * Provider route for the zero-cost models — those the gateway advertises as
   * free right now (list price 0, or a promotion that zeroes it).
   */
  providerId: Schema.string().default(defaults.providerId),
  /** Display name of the free lane in the model picker. */
  displayName: Schema.string().default(defaults.displayName),
  /** Provider route for every metered model. */
  accountProviderId: Schema.string().default(defaults.accountProviderId),
  /** Display name of the metered lane in the model picker. */
  accountDisplayName: Schema.string().default(defaults.accountDisplayName),
  /** Credential reference (env var name) holding the gateway API key, shared by both lanes. */
  apiKeyEnv: Schema.string().default(defaults.apiKeyEnv),
  /** Restart backoff: initial delay, ms. */
  restartDelayMs: Schema.number().step(1).min(0).default(defaults.restartDelayMs),
  /** Restart backoff: ceiling, ms. */
  restartMaxDelayMs: Schema.number().step(1).min(0).default(defaults.restartMaxDelayMs),
  /** Consecutive crashes before the plugin gives up restarting. */
  maxConsecutiveCrashes: Schema.number().step(1).min(0).default(defaults.maxConsecutiveCrashes),
  /** How long to wait for /healthz before declaring startup failed, ms. */
  startupTimeoutMs: Schema.number().step(1).min(1000).default(defaults.startupTimeoutMs),
  /** Extra CLI args appended after `-config <path>`. */
  extraArgs: Schema.array(Schema.string()).default([]),
})

/** Fill in the defaults so call sites never branch on `undefined`. */
export function resolveConfig(config = {}) {
  return { ...defaults, ...config }
}

/**
 * Cordis entry point.
 *
 * `config` is the resolved Config, in which the volatile fields are references
 * rather than values; a host that predates that hands over the raw patch object
 * instead, and {@link snapshot} copes with both spellings.
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger
  const runtime = new GatewayRuntime(ctx, logger)
  const read = () => snapshot(config)

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      void runtime.dispose()
    })
  }

  // A save from the Plugins page commits into the same references and announces
  // itself here; the runtime diffs the snapshot and does the minimum work.
  if (typeof ctx.on === 'function') {
    ctx.on('loader/volatile-update', () => {
      void runtime.reconfigure(read()).catch((err) => {
        logger.warn(
          `workbuddy2dsh: live reconfiguration failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
    })
  }

  void runtime.start(read()).catch((err) => {
    logger.error(
      `workbuddy2dsh: startup failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  })
}

export { GatewayRuntime, describeAccessDenial, snapshot } from './src/runtime.js'
export { GatewayProcess } from './src/gateway-process.js'
export { ensureGatewayConfig, generateApiKey } from './src/gateway-config.js'
export { findFreePort, waitForHealth } from './src/health.js'
export { BRIDGE_PREFIX, laneOf, parseCredits as parseCreditsText, readStatus } from './src/bridge.mjs'
export { bridgeRoute, isTrustedRequest } from './src/web-route.mjs'
export {
  fetchModels,
  isFreeModel,
  parseCredits,
  publishCredential,
  registerProvider,
  registerProviderLanes,
  removeProviderRoute,
  providerRoute,
  splitCatalog,
  toPiAiModel,
  toPiAiModels,
  toReasoningEfforts,
} from './src/provider.js'
export { defaultBinaryPath, defaultDataDir, panelUrl, providerBaseURL } from './src/paths.js'
