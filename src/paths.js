/**
 * Path resolution for the plugin.
 *
 * Everything the gateway persists lives under a single data directory
 * (`~/.workbuddy2dsh` by default). Nothing is ever written into the plugin's
 * own directory: a plugin installed from npm lives in a read-only tree, and a
 * `link:` checkout must not collect runtime state either.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of the directory holding this package's entry module. */
export function pluginRoot() {
  try {
    return fileURLToPath(new URL('..', import.meta.url))
  } catch {
    return process.cwd()
  }
}

/** `wb2api.exe` on Windows, `wb2api` elsewhere. */
export function binaryName() {
  return process.platform === 'win32' ? 'wb2api.exe' : 'wb2api'
}

/**
 * Locate the gateway binary. Order: the bundled copy in `bin/`, then the copy
 * the setup script leaves in `_runtime/`, then a bare name resolved from PATH
 * (which also lets a user point at a Docker-provided shim).
 */
export function defaultBinaryPath() {
  const name = binaryName()
  const root = pluginRoot()
  for (const candidate of [join(root, 'bin', name), join(root, '_runtime', name)]) {
    if (existsSync(candidate)) return candidate
  }
  return name
}

export function defaultDataDir() {
  return join(homedir(), '.workbuddy2dsh')
}

export function gatewayConfigPath(dataDir) {
  return join(dataDir, 'config.json')
}

export function credentialsDir(dataDir) {
  return join(dataDir, 'auths')
}

/** The gateway's OpenAI-compatible base, i.e. the route's `baseURL`. */
export function providerBaseURL(port) {
  return `http://127.0.0.1:${port}/v1`
}

/** The gateway's embedded management panel — where an account gets added. */
export function panelUrl(port) {
  return `http://127.0.0.1:${port}/panel/`
}
