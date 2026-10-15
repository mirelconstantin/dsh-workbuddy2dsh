import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { ensureGatewayConfig, generateApiKey, readGatewayConfig } from '../src/gateway-config.js'

let root

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb2dsh-cfg-'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

test('generateApiKey is prefixed and unique', () => {
  const a = generateApiKey()
  const b = generateApiKey()
  assert.match(a, /^sk-[A-Za-z0-9_-]{32}$/)
  assert.notEqual(a, b)
})

test('a missing config is seeded, and the data/auths directories are created', async () => {
  const dir = join(root, 'seed')
  const { configPath, apiKey, changed } = await ensureGatewayConfig(dir, 7863)

  assert.equal(changed, true)
  assert.equal(configPath, join(dir, 'config.json'))
  assert.match(apiKey, /^sk-/)

  const written = JSON.parse(await readFile(configPath, 'utf8'))
  assert.equal(written.listen, '127.0.0.1:7863')
  assert.equal(written.api_key, apiKey)
  assert.equal(written.auth_dir, './auths')
  assert.equal(written.state_file, './data/state.json')
  assert.equal(existsSync(join(dir, 'auths')), true)
  assert.equal(existsSync(join(dir, 'data')), true)
})

test('a re-run with the same port reuses the key and reports no change', async () => {
  const dir = join(root, 'stable')
  const first = await ensureGatewayConfig(dir, 7863)
  const second = await ensureGatewayConfig(dir, 7863)

  assert.equal(second.apiKey, first.apiKey)
  assert.equal(second.changed, false)
})

test('a port change rewrites listen but keeps the key and the user settings', async () => {
  const dir = join(root, 'port')
  const first = await ensureGatewayConfig(dir, 7863)

  // The user tunes something the plugin does not own.
  const configPath = join(dir, 'config.json')
  const edited = JSON.parse(await readFile(configPath, 'utf8'))
  edited.schedule = { checkin_hours: [7, 19] }
  edited.pool = { max_in_flight: 8 }
  await writeFile(configPath, `${JSON.stringify(edited, null, 2)}\n`, 'utf8')

  const second = await ensureGatewayConfig(dir, 8000)
  assert.equal(second.changed, true)
  assert.equal(second.apiKey, first.apiKey)

  const written = JSON.parse(await readFile(configPath, 'utf8'))
  assert.equal(written.listen, '127.0.0.1:8000')
  assert.deepEqual(written.schedule, { checkin_hours: [7, 19] })
  assert.deepEqual(written.pool, { max_in_flight: 8 })
})

test('a malformed config is a hard error rather than something to overwrite', async () => {
  const dir = join(root, 'broken')
  await ensureGatewayConfig(dir, 7863)
  await writeFile(join(dir, 'config.json'), '{ not json', 'utf8')

  await assert.rejects(() => ensureGatewayConfig(dir, 7863), /not valid JSON/)
  assert.equal(await readFile(join(dir, 'config.json'), 'utf8'), '{ not json')
})

test('attach mode reads the key and never writes the file', async () => {
  const dir = join(root, 'attach')
  await ensureGatewayConfig(dir, 7863)
  const configPath = join(dir, 'config.json')

  const before = await readFile(configPath, 'utf8')
  const result = await ensureGatewayConfig(dir, 9999, { write: false })

  assert.equal(result.changed, false)
  assert.match(result.apiKey, /^sk-/)
  // The listen port was NOT rewritten: the gateway is owned elsewhere.
  assert.equal(await readFile(configPath, 'utf8'), before)
  assert.equal(JSON.parse(before).listen, '127.0.0.1:7863')
})

test('attach mode without a config is an error', async () => {
  await assert.rejects(
    () => ensureGatewayConfig(join(root, 'attach-missing'), 7863, { write: false }),
    /does not exist/,
  )
})

test('readGatewayConfig returns null when there is no file', async () => {
  assert.equal(await readGatewayConfig(join(root, 'nothing-here')), null)
})
