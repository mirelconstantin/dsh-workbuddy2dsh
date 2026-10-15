/**
 * Child-process driver for the gateway.
 *
 * Spawn with piped stdio, forward both streams line-by-line into the DSH log,
 * restart with exponential backoff on an unexpected exit, trip a circuit
 * breaker after N consecutive crashes, and stop gracefully on dispose.
 *
 * A run that survives `stableAfterMs` resets the crash counter, so a slow leak
 * is not mistaken for a crash loop. Windows gets `taskkill /T` because POSIX
 * signals are not deliverable there; POSIX gets SIGTERM and a hard kill after
 * `gracefulStopMs`.
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

const STABLE_AFTER_MS = 30_000
const GRACEFUL_STOP_MS = 5_000

export class GatewayProcess extends EventEmitter {
  #child = null
  #restartTimer = null
  #stableTimer = null
  #stopping = false
  #disposed = false
  #crashes = 0
  #backoffMs

  /**
   * @param {object} options
   * @param {string} options.binaryPath
   * @param {string} options.configPath
   * @param {string} options.cwd           working directory for the child
   * @param {string[]} [options.extraArgs]
   * @param {number} options.restartDelayMs
   * @param {number} options.restartMaxDelayMs
   * @param {number} options.maxConsecutiveCrashes
   * @param {(line: string) => void} options.onLog
   */
  constructor(options) {
    super()
    this.options = options
    this.#backoffMs = options.restartDelayMs
  }

  get running() {
    return this.#child !== null
  }

  get crashes() {
    return this.#crashes
  }

  start() {
    if (this.#disposed || this.#stopping || this.#child) return
    const { binaryPath, configPath, cwd, extraArgs = [], onLog } = this.options

    const child = spawn(binaryPath, ['-config', configPath, ...extraArgs], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.#child = child

    const forward = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim().length > 0) onLog(line.trim())
      }
    }
    child.stdout?.on('data', forward)
    child.stderr?.on('data', forward)

    child.on('error', (err) => {
      onLog(`could not start ${binaryPath}: ${err.message}`)
    })

    child.on('exit', (code, signal) => {
      if (this.#child === child) this.#child = null
      if (this.#stopping || this.#disposed) return
      this.#handleCrash(code, signal)
    })

    this.#stableTimer = setTimeout(() => {
      this.#crashes = 0
      this.#backoffMs = this.options.restartDelayMs
    }, STABLE_AFTER_MS)
    // Pure bookkeeping: the running child is what keeps the process alive, so
    // this must never be the reason a shutdown waits out the full window.
    this.#stableTimer.unref?.()

    this.emit('state', 'started')
  }

  #handleCrash(code, signal) {
    this.#crashes += 1
    const { maxConsecutiveCrashes, restartMaxDelayMs, onLog } = this.options

    if (this.#crashes > maxConsecutiveCrashes) {
      onLog(
        `gateway exited ${this.#crashes} times in a row (last: code=${code} signal=${signal}); ` +
          'giving up — fix the cause and reload the plugin',
      )
      this.emit('state', 'tripped')
      return
    }

    const waitMs = this.#backoffMs
    this.#backoffMs = Math.min(this.#backoffMs * 2, restartMaxDelayMs)
    onLog(
      `gateway exited (code=${code} signal=${signal}); restarting in ${waitMs}ms ` +
        `(attempt ${this.#crashes})`,
    )
    this.emit('state', 'restarting')
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null
      if (!this.#stopping && !this.#disposed) this.start()
    }, waitMs)
  }

  /** Stop the child and wait for it to actually be gone. Idempotent. */
  async stop() {
    this.#stopping = true
    if (this.#restartTimer) clearTimeout(this.#restartTimer)
    if (this.#stableTimer) clearTimeout(this.#stableTimer)
    this.#restartTimer = null
    this.#stableTimer = null

    const child = this.#child
    this.#child = null
    if (!child || child.exitCode !== null) {
      this.emit('state', 'stopped')
      return
    }

    await new Promise((resolve) => {
      let settled = false
      // The escalation timer is cleared on the normal path: left pending it
      // holds the event loop for its full duration after every teardown, which
      // turns a clean stop into a five-second stall.
      let escalation = null
      const done = () => {
        if (settled) return
        settled = true
        if (escalation) clearTimeout(escalation)
        resolve()
      }
      child.once('exit', done)
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('exit', done)
      } else {
        child.kill('SIGTERM')
      }
      escalation = setTimeout(() => {
        child.kill('SIGKILL')
        done()
      }, GRACEFUL_STOP_MS)
    })

    this.emit('state', 'stopped')
  }

  /** Permanent teardown: stop, and refuse any further start(). */
  async dispose() {
    this.#disposed = true
    await this.stop()
  }
}
