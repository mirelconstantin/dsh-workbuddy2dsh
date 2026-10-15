/**
 * The gateway's lifecycle: one object owns the child process, the refresh
 * timer and the two published provider routes, so a live settings change can
 * tear the whole thing down and bring it back up without leaving a half-state
 * behind (a running child with no route, or a route pointing at a dead port).
 */

import { ensureGatewayConfig } from './gateway-config.js'
import { GatewayProcess } from './gateway-process.js'
import { delay, findFreePort, waitForHealth } from './health.js'
import { defaultBinaryPath, defaultDataDir, panelUrl } from './paths.js'
import { bridgeRoute } from './web-route.mjs'
import {
  fetchModels,
  publishCredential,
  registerProviderLanes,
  removeProviderRoute,
  splitCatalog,
  toPiAiModels,
} from './provider.js'

/**
 * A `Volatile<T>` reference is read at the moment it is needed and never
 * cached; a host that predates the volatile reference hands over a plain value,
 * so both spellings are accepted here.
 */
export function readVolatile(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value
}

/** Read every field of a config object, dereferencing volatile refs. */
export function snapshot(config) {
  const plain = {}
  for (const [key, value] of Object.entries(config ?? {})) plain[key] = readVolatile(value)
  return plain
}

/**
 * Read one service off a context, tolerating Cordis's refusal to hand it over.
 *
 * A context proxy THROWS on `ctx.<service>` unless that service is in the
 * fiber's own `inject` list (`cannot get property "x" without inject`). The
 * plugin declares `inject = []` on purpose — see `index.js` — so this read
 * normally throws, and the caller must fall through to `ctx.inject()` rather
 * than be killed by it. It still succeeds, and is worth attempting, when a
 * composition declares the seams in `inject` itself.
 */
function readService(ctx, name) {
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/**
 * Ask a context for a set of services on a fresh child fiber.
 *
 * `ctx.inject(deps, callback)` is the only way a fiber with an empty `inject`
 * can reach a service, because the child fiber it creates carries the
 * dependency declaration. Resolves with whatever it found, or with `{}` when
 * the services never arrive, so a composition that has none degrades instead
 * of parking the caller.
 */
function askForServices(ctx, services, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      void Promise.resolve(
        ctx.inject(services, (sctx) => {
          const found = {}
          for (const name of services) found[name] = readService(sctx, name)
          finish(found)
        }),
      )
    } catch {
      finish({})
    }
    void delay(timeoutMs).then(() => finish({}))
  })
}

/** Fields whose change requires a restart of the child process. */
const CONNECTION_FIELDS = [
  'enabled',
  'attachOnly',
  'binaryPath',
  'dataDir',
  'port',
  'apiKey',
  'extraArgs',
]

/** Fields whose change requires the provider routes to be rewritten. */
const ROUTE_FIELDS = [
  'providerId',
  'apiKeyEnv',
  'displayName',
  'accountProviderId',
  'accountDisplayName',
]

/**
 * Every route id this plugin can own, so a lane that empties out (a promotion
 * expiring, a login landing in another realm) has its route withdrawn instead
 * of left pointing at a live port with a stale model list.
 */
function laneIds(config) {
  return [config?.providerId, config?.accountProviderId].filter(
    (id) => typeof id === 'string' && id.length > 0,
  )
}

/**
 * Route ids this plugin published under its previous name.
 *
 * The rename would otherwise leave both old lanes in the picker for good:
 * nothing refreshes them, so they would sit there offering a frozen model list
 * against a live port. They are withdrawn on the first refresh that finds them,
 * and a config that deliberately still names one of them keeps it, because the
 * active set is consulted first.
 */
const LEGACY_LANE_IDS = ['workbuddy2api-free', 'workbuddy2api-acc']

/**
 * Build the lanes to publish from the gateway's catalogue.
 *
 * Free and metered are complementary, so together they still show the whole
 * catalogue — the split re-labels it, it does not hide anything. An empty lane
 * is dropped rather than published: a provider with no models appears in the
 * picker and cannot answer.
 */
function buildLanes(config, entries) {
  const { free, account } = splitCatalog(entries)
  return [
    {
      providerId: config.providerId,
      displayName: config.displayName,
      models: toPiAiModels(free),
    },
    {
      providerId: config.accountProviderId,
      displayName: config.accountDisplayName,
      models: toPiAiModels(account),
    },
  ].filter((lane) => lane.providerId && lane.models.length > 0)
}

function sameValue(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

function changedFields(before, after, fields) {
  if (!before) return fields.slice()
  return fields.filter((field) => !sameValue(before[field], after[field]))
}

/**
 * Explain an access-denied child, when that is what the child reported.
 *
 * The gateway exits with `winapi error #5` (or `EACCES`) when it cannot open
 * its own `config.json`. The usual cause on Windows is an integrity-level
 * mismatch: an executable carrying a Low mandatory label — which every file
 * created inside a sandboxed or low-integrity tree inherits — cannot open a
 * config that lives in a normal Medium-integrity directory.
 *
 * Nothing in the plugin can fix that from the inside, so the least it can do is
 * name it rather than leave `winapi error #5` as the only clue. The remedy is
 * an ordinary copy, not `icacls /setintegritylevel`: relabelling needs
 * `SeRelabelPrivilege`, which an unelevated process does not have, whereas a
 * copy made outside the labelled tree simply does not inherit the label.
 *
 * @param tail The child's recent output, joined.
 * @returns A message to log, or null when the child failed for another reason.
 */
export function describeAccessDenial(tail, binaryPath, dataDir) {
  if (!/winapi error #5|access is denied|EACCES|permission denied/i.test(String(tail ?? ''))) {
    return null
  }
  return (
    'workbuddy2dsh: the gateway cannot read its own data directory — the operating system ' +
    `denied access to ${dataDir}. On Windows this happens when the gateway binary (${binaryPath}) ` +
    'carries a Low mandatory integrity label but the data directory does not: a process cannot ' +
    'open a higher-integrity file. Copy the binary to a directory outside the restricted tree — ' +
    'an ordinary copy does not inherit the label — and point binaryPath at the copy.'
  )
}

export class GatewayRuntime {
  #ctx
  #logger
  #gateway = null
  #refreshTimer = null
  #seams = undefined
  #state = { port: 0, apiKey: '', warnedEmpty: false, published: false }
  /** Last credential pair handed to the credentials store, so a refresh does not rewrite it. */
  #credential = null
  /** Last credential outcome reported to the log, so a standing note is said once. */
  #credentialNote = undefined
  /** A short tail of the child's own output, for diagnosing a failed startup. */
  #gatewayTail = []
  /** The disposer for the web route the browser half reads, once registered. */
  #routeDisposer = null
  #current = null
  #disposed = false

  constructor(ctx, logger) {
    this.#ctx = ctx
    this.#logger = logger ?? ctx.logger
  }

  get port() {
    return this.#state.port
  }

  get panelUrl() {
    return this.#state.port ? panelUrl(this.#state.port) : null
  }

  /**
   * Publish the status route the composer-dock chip reads.
   *
   * Resolved through the same guarded read as the other seams, because
   * `webServer` is as optional as `settings`: a headless composition composes
   * no web server at all, and the chip simply has nothing to poll there. The
   * route is registered once and left alone across restarts — it reads the port
   * and key through accessors, so a gateway that restarts on a new port is
   * picked up without re-registering anything.
   */
  #registerRoute() {
    if (this.#routeDisposer !== null) return
    const webServer = readService(this.#ctx, 'webServer')
    if (!webServer || typeof webServer.register !== 'function') return
    try {
      const route = bridgeRoute({
        port: () => this.#state.port,
        apiKey: () => this.#state.apiKey,
      })
      this.#routeDisposer = webServer.register(route) ?? (() => {})
    } catch (err) {
      // A missing web server is a normal composition, not a fault: the chip
      // just never appears. Say so once rather than on every start.
      this.#logger.info(
        `workbuddy2dsh: no web server available, so the composer chip cannot be served: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      this.#routeDisposer = () => {}
    }
  }

  /**
   * Resolve `credentials` + `settings` without parking the fiber when a
   * composition has neither. The gateway itself must keep running regardless,
   * because its panel is where an account gets added.
   *
   * The two seams are asked for on SEPARATE child fibers and raced
   * independently. Asking for both at once would make `credentials` hostage to
   * `settings`, and `settings` is the one that is genuinely optional — it
   * ships disabled wherever no `profileContext` exists (headless, CLI). The
   * gateway key still belongs in the store in those compositions, and the
   * route simply cannot be published without `settings`.
   */
  #resolveSeams() {
    if (this.#seams) return this.#seams

    const carried = {
      credentials: readService(this.#ctx, 'credentials'),
      settings: readService(this.#ctx, 'settings'),
    }
    if (carried.credentials && carried.settings) {
      this.#seams = Promise.resolve(carried)
      return this.#seams
    }
    if (typeof this.#ctx.inject !== 'function') {
      this.#seams = Promise.resolve(carried)
      return this.#seams
    }

    this.#seams = Promise.all([
      carried.credentials ?? askForServices(this.#ctx, ['credentials'], 3000),
      carried.settings ?? askForServices(this.#ctx, ['settings'], 3000),
    ]).then(([credentials, settings]) => ({
      credentials: credentials?.credentials ?? carried.credentials,
      settings: settings?.settings ?? carried.settings,
    }))
    return this.#seams
  }

  /** Start (or restart) against a resolved settings snapshot. */
  async start(config) {
    this.#current = config
    if (this.#disposed) return
    if (config.enabled === false) {
      this.#logger.info('workbuddy2dsh: disabled by configuration; the gateway is not started')
      return
    }

    const dataDir = config.dataDir || defaultDataDir()
    const binaryPath = config.binaryPath || defaultBinaryPath()

    try {
      const port = config.port > 0 ? config.port : await findFreePort()
      const attachOnly = config.attachOnly === true

      // Attach mode never writes: the gateway is owned elsewhere (a container,
      // a system service) and the plugin only borrows its endpoint.
      const { configPath, apiKey, changed } = await ensureGatewayConfig(dataDir, port, {
        write: !attachOnly,
        apiKey: config.apiKey,
      })
      this.#state.port = port
      this.#state.apiKey = apiKey
      if (changed) this.#logger.info(`workbuddy2dsh: wrote gateway config ${configPath}`)
      this.#registerRoute()

      if (attachOnly) {
        this.#logger.info(`workbuddy2dsh: attach mode — using the gateway already on 127.0.0.1:${port}`)
      } else {
        this.#logger.info(`workbuddy2dsh: starting gateway ${binaryPath} (data: ${dataDir})`)
        this.#gateway = new GatewayProcess({
          binaryPath,
          configPath,
          cwd: dataDir,
          extraArgs: config.extraArgs ?? [],
          restartDelayMs: config.restartDelayMs,
          restartMaxDelayMs: config.restartMaxDelayMs,
          maxConsecutiveCrashes: config.maxConsecutiveCrashes,
          onLog: (line) => {
            // Keep the last few lines: a startup that fails leaves nothing else
            // behind, and the child's own message is the only evidence.
            this.#gatewayTail.push(line)
            if (this.#gatewayTail.length > 8) this.#gatewayTail.shift()
            this.#logger.info(`[gateway] ${line}`)
          },
        })
        this.#gateway.start()
      }

      const health = await waitForHealth(port, config.startupTimeoutMs)
      this.#logger.info(
        `workbuddy2dsh: gateway ready on 127.0.0.1:${port}/v1 ` +
          `(${health.body?.total ?? 0} account(s)); management panel: ${panelUrl(port)}`,
      )
      // The panel demands this key before it will show anything, and nothing
      // else in the UI reveals it — so it is stated once, with where to change it.
      this.#logger.info(
        `workbuddy2dsh: gateway API key is ${apiKey} (the panel asks for it) — ` +
          (attachOnly
            ? `read from ${configPath}`
            : `change it with the "apiKey" setting or in ${configPath}`),
      )

      await this.refresh(config)
      if (!this.#disposed) this.#schedule(config)
    } catch (err) {
      this.#logger.error(
        `workbuddy2dsh: startup failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      const denied = describeAccessDenial(
        this.#gatewayTail.join('\n'),
        this.#current?.binaryPath || defaultBinaryPath(),
        this.#current?.dataDir || defaultDataDir(),
      )
      if (denied) this.#logger.error(denied)
      // A child that is up but slow (a first-run migration, a cold cache) must
      // not be abandoned: keep the refresh loop armed so the catalog is picked
      // up the moment it answers, rather than only on the next plugin load.
      if (!this.#disposed && (this.#gateway || config.attachOnly === true)) {
        this.#schedule(config)
      }
    }
  }

  /** Fetch the catalog and publish it. Returns whether a route was written. */
  async refresh(config = this.#current) {
    if (this.#disposed || !this.#state.port || !config) return false
    try {
      const { credentials, settings } = await this.#resolveSeams()

      // The credential is published before the catalog is read, not after a
      // route exists. The key belongs to the gateway, which is already up, and
      // a login that lands between two refreshes must be servable on the next
      // tick — not one tick after that, once a route finally exists.
      //
      // It is also published without waiting on `settings`: the store is what
      // the route will resolve the key through, and a composition that cannot
      // carry the route can still keep the key ready for one that can.
      if (credentials) {
        await this.#publishCredential(config, credentials)
      } else {
        this.#logger.warn(
          'workbuddy2dsh: the credentials service is unavailable; the gateway API key is not stored, ' +
            `so requests will fail with MISSING_CREDENTIAL until ${config.apiKeyEnv} is set in the environment`,
        )
      }

      const entries = await fetchModels(this.#state.port, this.#state.apiKey)
      if (entries.length === 0) {
        // An empty catalog means "no account yet", not "no models": the gateway
        // answers with an empty list until a login lands. Say so once, and let
        // the caller retry on the short interval.
        if (!this.#state.warnedEmpty) {
          this.#state.warnedEmpty = true
          this.#logger.info(
            'workbuddy2dsh: the gateway exposes no models yet — add a WorkBuddy account in the ' +
              `panel at ${panelUrl(this.#state.port)} and the models will appear in the picker automatically`,
          )
        }
        return false
      }

      this.#state.warnedEmpty = false

      if (!settings) {
        this.#logger.warn(
          'workbuddy2dsh: the settings service is unavailable; the models are not published to the picker',
        )
        return false
      }

      const lanes = buildLanes(config, entries)

      // A lane that produced no models this round must not keep the route it
      // had: a promotion expiring would otherwise leave the picker offering a
      // model list the gateway no longer prices that way.
      const active = new Set(lanes.map((lane) => lane.providerId))
      for (const id of [...laneIds(config), ...LEGACY_LANE_IDS]) {
        if (active.has(id)) continue
        if (!(await removeProviderRoute({ settings }, id))) continue
        this.#logger.info(
          LEGACY_LANE_IDS.includes(id)
            ? `workbuddy2dsh: withdrew provider route "${id}" — left over from the plugin's previous name`
            : `workbuddy2dsh: withdrew provider route "${id}" — it has no models`,
        )
      }

      const ok = await registerProviderLanes(
        { settings, logger: this.#logger },
        { apiKeyEnv: config.apiKeyEnv, port: this.#state.port },
        lanes,
      )
      this.#state.published = ok
      return ok
    } catch (err) {
      this.#logger.warn(
        `workbuddy2dsh: model refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      return false
    }
  }

  /**
   * Hand the gateway key to the credentials store and report what happened.
   *
   * Split out of {@link refresh} because its failure modes have nothing to do
   * with the catalog: a missing store or a shadowing environment variable are
   * credential facts, and neither should stop the model list from refreshing.
   */
  async #publishCredential(config, credentials) {
    const outcome = await publishCredential(
      { credentials },
      config.apiKeyEnv,
      this.#state.apiKey,
      this.#credential,
    )
    // Only a store write is memoized: the shadowed cases are never written,
    // so they are re-examined on every refresh and must not be latched.
    if (outcome === 'written') {
      this.#credential = { ref: config.apiKeyEnv, value: this.#state.apiKey }
    }
    // The note is reported when it changes, not every cycle: a reference the
    // environment owns stays in that state for the life of the process.
    if (outcome === this.#credentialNote) return
    this.#credentialNote = outcome
    switch (outcome) {
      case 'shadowed-mismatch':
        // The launching environment supplies this reference, so the store
        // cannot be written and the exported value is what every request will
        // send. If it is not the gateway's key, the only symptom is a 401 per
        // request, so name the cause here instead.
        this.#logger.warn(
          `workbuddy2dsh: ${config.apiKeyEnv} is exported by the environment and does not match the ` +
            'gateway API key; requests will be rejected. Unset it and reload the plugin, or set it to ' +
            `the key in ${config.dataDir || defaultDataDir()}/config.json`,
        )
        break
      case 'shadowed-match':
        this.#logger.info(
          `workbuddy2dsh: ${config.apiKeyEnv} is supplied by the environment and matches the gateway key`,
        )
        break
      case 'unsupported':
        this.#logger.warn(
          'workbuddy2dsh: the credentials seam cannot store the gateway API key; the route will fail ' +
            `with MISSING_CREDENTIAL until ${config.apiKeyEnv} is set in the environment`,
        )
        break
      default:
        break
    }
  }

  #schedule(config) {
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer)
    // An empty catalog is a transient waiting state, not a steady one: poll
    // briskly so the picker fills in seconds after the panel login.
    const seconds = this.#state.published
      ? Math.max(5, config.refreshSeconds ?? 300)
      : Math.min(Math.max(5, config.refreshSeconds ?? 300), 15)
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null
      if (this.#disposed) return
      void this.refresh(config).then(() => {
        if (!this.#disposed) this.#schedule(config)
      })
    }, seconds * 1000)
  }

  /**
   * Apply a new settings snapshot. A connection change restarts the child; a
   * route change republishes in place; a refresh-interval change only re-arms
   * the timer. Returns a short description of what happened, for tests.
   */
  async reconfigure(next) {
    const previous = this.#current
    this.#current = next

    const connection = changedFields(previous, next, CONNECTION_FIELDS)
    const route = changedFields(previous, next, ROUTE_FIELDS)
    const refreshChanged = !sameValue(previous?.refreshSeconds, next.refreshSeconds)

    if (connection.length > 0) {
      this.#logger.info(`workbuddy2dsh: reconfiguring (${connection.join(', ')})`)
      await this.stop({ unpublish: false })
      this.#disposed = false
      this.#state = { port: 0, apiKey: '', warnedEmpty: false, published: false }
      await this.start(next)
      return `restart:${connection.join(',')}`
    }

    if (route.length > 0) {
      await this.#unpublish(previous)
      await this.refresh(next)
    }
    if (refreshChanged) this.#schedule(next)
    return route.length > 0 || refreshChanged ? `refresh:${[...route, ...(refreshChanged ? ['refreshSeconds'] : [])].join(',')}` : 'noop'
  }

  async #unpublish(config) {
    const ids = laneIds(config)
    if (ids.length === 0) return false
    try {
      const { settings } = await this.#resolveSeams()
      if (!settings) return false
      let removed = false
      for (const id of ids) {
        if (await removeProviderRoute({ settings }, id)) {
          this.#logger.info(`workbuddy2dsh: removed provider route "${id}"`)
          removed = true
        }
      }
      if (removed) this.#state.published = false
      return removed
    } catch (err) {
      this.#logger.warn(
        `workbuddy2dsh: could not remove the provider route: ${err instanceof Error ? err.message : String(err)}`,
      )
      return false
    }
  }

  /**
   * Stop the gateway. The route is removed by default: leaving it behind would
   * point every dispatch at a dead port and shadow any later provider.
   */
  async stop({ unpublish = true } = {}) {
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer)
    this.#refreshTimer = null
    if (unpublish) await this.#unpublish(this.#current)
    const gateway = this.#gateway
    this.#gateway = null
    if (gateway) await gateway.dispose()
  }

  /** Permanent teardown. */
  async dispose() {
    this.#disposed = true
    // The route outlives a restart on purpose (it reads the port through an
    // accessor), so it is withdrawn here rather than in stop().
    const disposer = this.#routeDisposer
    this.#routeDisposer = null
    if (disposer) {
      try {
        disposer()
      } catch (err) {
        this.#logger.warn(
          `workbuddy2dsh: could not withdraw the status route: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
    await this.stop({ unpublish: true })
  }
}
