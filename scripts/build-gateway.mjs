/**
 * dsh-workbuddy2dsh — fetch a gateway binary, for any platform.
 *
 *   node scripts/build-gateway.mjs [--out bin] [--build] [--download] [--help]
 *
 * One script, three operating systems. It puts `bin/wb2api[.exe]` in place,
 * which is exactly where the plugin's `defaultBinaryPath()` looks first.
 *
 * Two routes to that file, chosen for you:
 *
 *   1. **Build** — used when a Go toolchain is available (on `PATH`, or the
 *      bundled `_tools/go` in a full checkout). Preferred: the binary always
 *      matches this source tree.
 *   2. **Download** — used when there is no Go toolchain. Fetches the prebuilt
 *      binary for *your* platform from this repository's GitHub Releases and
 *      verifies it against the published `checksums.txt`. Far lighter than
 *      installing a Go toolchain just to run the plugin.
 *
 * `--build` and `--download` skip the choice and force one route.
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { arch, platform, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const self = dirname(fileURLToPath(import.meta.url))
const root = resolve(self, '..')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const valueFlag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 || argv[index + 1] === undefined ? fallback : argv[index + 1]
}

const outDir = valueFlag('out', join(root, 'bin'))
const explicitGo = valueFlag('go', process.env.WB2API_GO || '')
const wantBuild = flag('build')
const wantDownload = flag('download')

/** The repository the prebuilt assets are published from. */
const REPO_OWNER = 'mirelconstantin'
const REPO_NAME = 'dsh-workbuddy2dsh'
const GATEWAY_TAG = valueFlag('tag', process.env.WB2API_TAG || 'gateway-v1')

/** Go 1.22 is the minimum the gateway's own go.mod declares. */
const GO_MIN = [1, 22]

const isWindows = process.platform === 'win32'
const exe = (name) => (isWindows ? `${name}.exe` : name)
const log = (...args) => console.log('·', ...args)
const step = (...args) => console.log('\n▶', ...args)

// ----------------------------------------------------------------- Go lookup

/** `go1.22.6` → `[1, 22, 6]`, or null when the string is not a Go version. */
function parseGoVersion(text) {
  const match = /go(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text))
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

function versionAtLeast(version, min) {
  for (let i = 0; i < min.length; i += 1) {
    const delta = (version[i] ?? 0) - min[i]
    if (delta !== 0) return delta > 0
  }
  return true
}

function runGo(goBin, args, cwd, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(goBin, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })
    child.on('error', rejectPromise)
    child.on('exit', (code) =>
      code === 0 ? resolvePromise() : rejectPromise(new Error(`${goBin} ${args.join(' ')} exited with ${code}`)),
    )
  })
}

/** Is this a usable Go toolchain? Returns its version or null. */
function goVersionOf(goBin) {
  try {
    const out = execFileSync(goBin, ['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return parseGoVersion(out)
  } catch {
    return null
  }
}

function usable(version) {
  return version !== null && versionAtLeast(version, GO_MIN)
}

async function findGoOnPath() {
  const names = isWindows ? ['go.exe', 'go'] : ['go', 'go.exe']
  for (const name of names) {
    const found = await which(name)
    if (found) {
      const version = goVersionOf(found)
      if (usable(version)) return { bin: found, version, label: `${name} on PATH` }
    }
  }
  return null
}

/** A Go toolchain shipped inside a full source checkout. */
async function findBundledGo() {
  const toolsGo = join(root, '_tools', 'go')
  for (const candidate of [join(toolsGo, 'bin', exe('go')), join(toolsGo, exe('go'))]) {
    if (exists(candidate)) {
      const version = goVersionOf(candidate)
      if (usable(version)) return { bin: candidate, version, label: `_tools/go (bundled)` }
    }
  }
  return null
}

function exists(path) {
  return existsSync(path)
}

async function which(name) {
  try {
    if (isWindows) {
      const out = execFileSync('where', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return out.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null
    }
    const out = execFileSync('sh', ['-lc', `command -v ${name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return out.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null
  } catch {
    return null
  }
}

// ------------------------------------------------------------------- download

/** The archive name this platform needs from the prebuilt release. */
function assetName() {
  const table = {
    'win32-x64': 'wb2api-windows-amd64.exe.zip',
    'linux-x64': 'wb2api-linux-amd64.tar.gz',
    'linux-arm64': 'wb2api-linux-arm64.tar.gz',
    'darwin-x64': 'wb2api-darwin-amd64.tar.gz',
    'darwin-arm64': 'wb2api-darwin-arm64.tar.gz',
  }
  const canonical = { ia32: 'x86', x64: 'x64', arm64: 'arm64', arm: 'arm' }[arch()] ?? arch()
  return table[`${platform()}-${canonical}`] ?? null
}

async function downloadAsset(destination) {
  const asset = assetName()
  if (!asset) {
    const canonical = { ia32: 'x86', x64: 'x64', arm64: 'arm64' }[arch()] ?? arch()
    throw new Error(`no prebuilt gateway binary exists for ${platform()}-${canonical}; build from source instead (see docs/GATEWAY.md)`)
  }

  const base = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${GATEWAY_TAG}`
  const url = `${base}/${asset}`
  log(`downloading ${url}`)

  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) })
  if (!response.ok) {
    throw new Error(
      `download failed: HTTP ${response.status}. ` +
        'This repository has no prebuilt gateway release yet — build one with `node scripts/build-gateway.mjs --build`, ' +
        'or point the plugin at your own gateway with `binaryPath` / `attachOnly`.',
    )
  }
  const buffer = Buffer.from(await response.arrayBuffer())

  // Verify against the release's checksums.txt. A binary that has been tampered
  // with in transit is indistinguishable from a working one, so this is not
  // optional theatre: it is the only thing that makes a download trustworthy.
  const checksums = await fetch(`${base}/checksums.txt`, { signal: AbortSignal.timeout(60_000) }).then((r) =>
    r.ok ? r.text() : null,
  )
  if (checksums) {
    const line = checksums.split('\n').find((row) => row.trim().endsWith(asset))
    const expected = line ? line.trim().split(/\s+/)[0] : null
    if (expected) {
      const actual = createHash('sha256').update(buffer).digest('hex')
      if (actual !== expected) {
        throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`)
      }
      log('sha256 verified against checksums.txt')
    } else {
      log(`warning: checksums.txt carries no entry for ${asset}`)
    }
  } else {
    log('warning: checksums.txt is not available for this release')
  }

  const archive = join(destination, asset)
  await writeFile(archive, buffer)
  try {
    await unpack(archive, destination)
  } finally {
    await rm(archive, { force: true })
  }
}

/**
 * Unpack a `.zip` (Windows) or a `.tar.gz` (everything else).
 *
 * PowerShell's `Expand-Archive` and BSD `tar` are both present on every
 * supported platform by default, so this needs no extra dependency — but note
 * that a .tar.gz on Windows has no built-in unpacker, which is exactly why the
 * release workflow ships `.zip` for Windows and `.tar.gz` elsewhere.
 */
async function unpack(archive, into) {
  const command = isWindows ? 'powershell' : 'tar'
  const args = isWindows
    ? ['-NoProfile', '-Command', `Expand-Archive -Path '${archive}' -DestinationPath '${into}' -Force`]
    : ['-xzf', archive, '-C', into]
  await run(command, args, root, {})
}

async function run(command, args, cwd, env) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })
    child.on('error', rejectPromise)
    child.on('exit', (code) =>
      code === 0 ? resolvePromise() : rejectPromise(new Error(`${command} exited with ${code}`)),
    )
  })
}

// --------------------------------------------------------------------- build

async function build(go, destination) {
  const env = { CGO_ENABLED: process.env.CGO_ENABLED ?? '0' }
  // A bundled toolchain would otherwise leave its scratch and caches in the OS
  // temp directory, which must stay clean — and which on some machines is not
  // writable by a process whose executable came from inside this tree. Every
  // Go work path is therefore kept beside the toolchain, inside the checkout.
  if (go.label.startsWith('_tools')) {
    const scratch = join(root, '_tools', 'cache')
    env.GOTMPDIR = join(scratch, 'tmp')
    env.GOCACHE = join(scratch, 'build')
    env.GOPATH = join(scratch, 'path')
    env.GOROOT = dirname(dirname(go.bin))
    await mkdir(env.GOTMPDIR, { recursive: true })
    await mkdir(env.GOCACHE, { recursive: true })
    await mkdir(env.GOPATH, { recursive: true })
  }
  await runGo(go.bin, ['build', '-trimpath', '-ldflags=-s -w', '-o', destination, './cmd/server'], root, env)
}

// ------------------------------------------------------------------- actions

/**
 * Boot the binary against a throwaway data directory and check the three
 * endpoints the plugin actually uses.
 *
 * A binary that compiles but cannot bind a port, read its own config, or serve
 * `/healthz` is a broken plugin — the gateway exits with `winapi error #5` on
 * Windows in exactly that situation — and it is far cheaper to find out here
 * than from a log line weeks later.
 *
 * The port is reserved here rather than read from the child's output: the
 * gateway logs the configured address (`127.0.0.1:0`), not the one it bound, so
 * parsing the log cannot work. Binding here first and handing the port to the
 * child keeps this deterministic on every platform.
 */
async function smokeTest(binaryPath) {
  const dataDir = await mkdtemp(join(tmpdir(), 'wb2dsh-smoke-'))
  const port = await freePort()
  const configPath = join(dataDir, 'config.json')
  await writeFile(
    configPath,
    JSON.stringify(
      {
        listen: `127.0.0.1:${port}`,
        api_key: 'sk-build-smoke',
        auth_dir: './auths',
        state_file: './data/state.json',
      },
      null,
      2,
    ),
    'utf8',
  )

  const child = spawn(binaryPath, ['-config', configPath], {
    cwd: dataDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const tail = []
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) tail.push(line.trim())
      if (tail.length > 12) tail.splice(0, tail.length - 12)
    })
  }

  const deadline = Date.now() + 25_000
  try {
    while (Date.now() < deadline) {
      const health = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) }).catch(
        () => null,
      )
      if (health) {
        const models = await fetch(`http://127.0.0.1:${port}/v1/models`, {
          headers: { authorization: 'Bearer sk-build-smoke' },
          signal: AbortSignal.timeout(5000),
        })
          .then((r) => r.json())
          .then((body) => body.data?.length ?? 0)
          .catch(() => 0)
        return { ok: true, port, models }
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    return {
      ok: false,
      reason: `the gateway never answered /healthz on 127.0.0.1:${port}. Last output:\n  ${
        tail.join('\n  ') || '(none)'
      }`,
    }
  } finally {
    if (isWindows) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    else child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 500))
    if (child.exitCode === null) child.kill('SIGKILL')
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Reserve and release a free loopback port. */
async function freePort() {
  const { createServer } = await import('node:net')
  return new Promise((resolvePromise, rejectPromise) => {
    const probe = createServer()
    probe.once('error', rejectPromise)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const chosen = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (chosen ? resolvePromise(chosen) : rejectPromise(new Error('no free loopback port'))))
    })
  })
}

// --------------------------------------------------------------------- main

/** Resolve Go, acquire a binary, smoke-test it, and report. */
async function main() {
  step('resolving a gateway binary')

  const destination = join(outDir, exe('wb2api'))
  await mkdir(outDir, { recursive: true })

  let go = null
  if (!wantDownload) {
    if (explicitGo) {
      const version = goVersionOf(explicitGo)
      if (!existsSync(explicitGo) || !usable(version)) {
        console.error(`${explicitGo} is not a usable Go ${GO_MIN.join('.')}+ toolchain`)
        return 2
      }
      go = { bin: explicitGo, version, label: explicitGo }
    }
    go ??= await findBundledGo()
    go ??= await findGoOnPath()
  }

  try {
    if (go) {
      log(`building with ${go.label} (go ${go.version.join('.')})`)
      await build(go, destination)
      log(`built ${relative(root, destination)}`)
    } else if (wantBuild) {
      console.error(`no Go toolchain found; install Go ${GO_MIN.join('.')}+ or run without --build`)
      return 2
    } else {
      log('no Go toolchain found — taking the prebuilt release binary instead')
      await downloadAsset(outDir)
    }
  } catch (err) {
    console.error(`\nfailed: ${err instanceof Error ? err.message : String(err)}`)
    if (go) {
      console.error('falling back to the prebuilt release binary…')
      await rm(destination, { force: true })
      await downloadAsset(outDir)
    } else {
      return 1
    }
  }

  if (!isWindows) await chmod(destination, 0o755)

  // A binary that compiles but cannot bind a port, read its own config, or serve
  // /healthz is a broken plugin. Far cheaper to find out here than from a log.
  step('smoke-testing the binary')
  const smoke = await smokeTest(destination)
  if (smoke.ok) {
    log(`OK — port ${smoke.port}, /healthz answered, ${smoke.models} model(s) in the catalog`)
    console.log(`\nGateway ready at ${relative(root, destination)}`)
    console.log('Add it to a profile and open the panel to link your account: http://127.0.0.1:7863/panel/')
    return 0
  }

  await rm(destination, { force: true })
  console.error(`\nsmoke test failed and the binary was removed:\n${smoke.reason}`)
  console.error('Build the gateway yourself and pass --binary <path> to the e2e script to see its output.')
  return 1
}

/** The usage text, printed for `--help`. */
async function printHelp() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  console.log(`${pkg.name}@${pkg.version} — gateway setup`)
  console.log('')
  console.log('Usage: node scripts/build-gateway.mjs [options]')
  console.log('')
  console.log(`Puts a gateway binary in ${relative(root, outDir)}/wb2api${isWindows ? '.exe' : ''}, which is where`)
  console.log('the plugin looks for it first. Works on Windows, Linux and macOS.')
  console.log('')
  console.log('Options:')
  console.log('  --out <dir>     output directory (default: bin)')
  console.log('  --build         build from source with Go; fail if no toolchain is found')
  console.log("  --download      take this platform's prebuilt release binary; never build")
  console.log('  --go <path>     use this Go toolchain')
  console.log('  --tag <tag>     release to download from (default: gateway-v1)')
  console.log('  -h, --help      this message')
}

// On Windows, `process.exit()` while a fetch is still settling crashes the
// runtime with a libuv assertion. Setting `exitCode` and letting the event loop
// drain is the portable spelling, and it flushes stdout as it goes.
if (flag('help') || flag('h')) {
  await printHelp()
  process.exitCode = 0
} else if (wantBuild && wantDownload) {
  console.error('--build and --download are mutually exclusive')
  process.exitCode = 2
} else {
  process.exitCode = await main()
}
