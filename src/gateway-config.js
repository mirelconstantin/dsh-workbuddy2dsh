/**
 * Ownership of the gateway's own `config.json`.
 *
 * The gateway has a large configuration surface of its own (pool tuning,
 * cooldown windows, the check-in schedule, prompt mode, request logging,
 * Upstash mirroring, …). This plugin owns exactly two fields of it — `listen`
 * and `api_key` — because it is the party that picked the port and owns the
 * key. Everything else is left exactly as the user left it, and a config that
 * does not exist yet is seeded with the same defaults the gateway would
 * generate for itself.
 *
 * Relative `auth_dir` / `state_file` are resolved by the gateway against its
 * working directory, which is why the child is spawned with `cwd: <dataDir>`.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { gatewayConfigPath } from './paths.js'

/** The seed written when no config.json exists yet. */
function seedConfig() {
  return {
    auth_dir: './auths',
    state_file: './data/state.json',
    panel: { package_detail_limit: 5 },
    server: { read_timeout: '300s' },
    logging: {
      request_archive_enabled: true,
      request_retention_days: 7,
      request_archive_max_mb: 100,
      request_client_info: true,
    },
  }
}

/**
 * The gateway API key a fresh install gets.
 *
 * A fixed, published default rather than a random per-install secret: the
 * gateway's panel asks for this key before it will show anything, and a random
 * one left every user (and every agent setting the plugin up) hunting through
 * `config.json` for a value they had never been told. It is loopback-only, and
 * the upstream default is *no* authentication at all, so a known key is the
 * stricter of the two. Override it with the plugin's `apiKey` setting.
 */
export const DEFAULT_API_KEY = 'sk-workbuddy2dsh'

/**
 * Read the existing config, or `null` when there is none.
 * A malformed file is a hard error: silently overwriting a config the user has
 * been tuning would be worse than refusing to start.
 */
export async function readGatewayConfig(dataDir) {
  const configPath = gatewayConfigPath(dataDir)
  if (!existsSync(configPath)) return null
  try {
    return JSON.parse(await readFile(configPath, 'utf8'))
  } catch (err) {
    throw new Error(
      `${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Ensure the data directory and its `config.json` are in place, and report the
 * API key the plugin must present. Returns `{ configPath, apiKey, changed }`.
 *
 * The key is resolved in that order: the `apiKey` option (the user's explicit
 * choice, which wins over the file), then whatever `config.json` already holds
 * — so an install that generated its own key long ago keeps it — then
 * {@link DEFAULT_API_KEY} on a fresh one.
 *
 * When `write` is false (attach mode — the gateway is managed elsewhere) the
 * file is only read: an existing key is reused, and a missing file is an error
 * rather than something this plugin invents.
 */
export async function ensureGatewayConfig(dataDir, port, { write = true, apiKey = '' } = {}) {
  await mkdir(join(dataDir, 'auths'), { recursive: true })
  await mkdir(join(dataDir, 'data'), { recursive: true })

  const existing = await readGatewayConfig(dataDir)
  const configPath = gatewayConfigPath(dataDir)

  if (!write) {
    if (!existing) {
      throw new Error(
        `${configPath} does not exist and the plugin is not managing it — ` +
          'point dataDir at a directory that already holds the gateway config',
      )
    }
    return { configPath, apiKey: String(existing.api_key ?? ''), changed: false }
  }

  const key =
    apiKey ||
    (typeof existing?.api_key === 'string' && existing.api_key.length > 0
      ? existing.api_key
      : DEFAULT_API_KEY)

  const next = {
    ...(existing ?? seedConfig()),
    listen: `127.0.0.1:${port}`,
    api_key: key,
  }

  const serialised = `${JSON.stringify(next, null, 2)}\n`
  const previous = existing ? `${JSON.stringify(existing, null, 2)}\n` : null
  if (serialised !== previous) {
    await writeFile(configPath, serialised, 'utf8')
    return { configPath, apiKey: key, changed: true }
  }
  return { configPath, apiKey: key, changed: false }
}
