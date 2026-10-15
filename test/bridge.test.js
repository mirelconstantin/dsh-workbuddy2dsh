import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { laneOf, parseCredits, readStatus, unreachableView } from '../src/bridge.mjs'

/**
 * A stub gateway panel answering the three endpoints the bridge reads, so the
 * real readStatus() runs against real JSON rather than a mocked fetch.
 */
function startPanel({ overview, models, usage, modelsStatus = 200 } = {}) {
  const server = createServer((req, res) => {
    res.setHeader('connection', 'close')
    const keyed = req.headers.authorization === 'Bearer sk-test'
    if (req.url === '/panel/api/overview' && keyed) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(overview ?? { total: 3, healthy: 2, cooling: 1, disabled: 0 }))
      return
    }
    if (req.url === '/panel/api/models') {
      // The panel answers 503 while the pool is still empty, so this honours
      // the status the caller wants to exercise.
      if (modelsStatus !== 200 || !keyed) {
        res.writeHead(modelsStatus).end('unavailable')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, models: models ?? [] }))
      return
    }
    if (req.url === '/panel/api/usage' && keyed) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(usage ?? { totals: { credits: 12.5 } }))
      return
    }
    res.writeHead(404).end()
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

const CATALOG = [
  // A promotion that zeroes a non-zero list price: the free lane's whole point.
  { id: 'global:deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', credits: 'x0.79', promo_factor: 0, promo_label: 'Free now' },
  // A zero list price with no promotion: free by price alone.
  { id: 'global:hy3', name: 'Hy3', credits: 'x0.00' },
  // Metered, promotion or not.
  { id: 'cn:glm-5.2', name: 'GLM-5.2', credits: 'x0.79' },
  // Never priced anywhere: the conservative default is the account lane.
  { id: 'global:default-model', name: 'Default Model' },
  // A half-price promotion is still not free.
  { id: 'cn:kimi', name: 'Kimi', credits: 'x1.60', promo_factor: 0.5 },
]

test('parseCredits reads the multiplier and reports silence as unknown', () => {
  assert.equal(parseCredits('x0.00'), 0)
  assert.equal(parseCredits('x0.79 credits'), 0.79)
  assert.equal(parseCredits('x3.33'), 3.33)
  // An absent or non-numeric price is unknown, not free.
  assert.equal(parseCredits(''), null)
  assert.equal(parseCredits(undefined), null)
  assert.equal(parseCredits('free'), null)
})

test('laneOf puts only an affirmative zero in the free lane', () => {
  // The rule the runtime publishes with: promo_factor wins, and only an
  // explicit zero is free. An unpriced model must never read as free.
  assert.equal(laneOf({ credits: 'x0.79', promo_factor: 0 }), 'free')
  assert.equal(laneOf({ credits: 'x0.00' }), 'free')
  assert.equal(laneOf({ credits: 'x0.79' }), 'account')
  assert.equal(laneOf({ credits: 'x1.60', promo_factor: 0.5 }), 'account')
  assert.equal(laneOf({}), 'account')
})

test('readStatus reads pool, catalogue and spend in one view', async () => {
  const panel = await startPanel({ models: CATALOG })
  try {
    const view = await readStatus(panel.port, 'sk-test')

    assert.equal(view.reachable, true)
    assert.equal(view.error, '')
    assert.equal(view.pool.total, 3)
    assert.equal(view.pool.healthy, 2)
    assert.equal(view.creditsSpent, 12.5)

    assert.deepEqual(
      view.freeModels.map((m) => m.id),
      ['global:deepseek-v4.1-flash', 'global:hy3'],
    )
    assert.deepEqual(
      view.accountModels.map((m) => m.id),
      ['cn:glm-5.2', 'global:default-model', 'cn:kimi'],
    )

    // The promotion fields ride through, because the chip shows them.
    const promo = view.freeModels[0]
    assert.equal(promo.promoFactor, 0)
    assert.equal(promo.promoLabel, 'Free now')
    assert.equal(promo.credits, 'x0.79')
  } finally {
    await panel.close()
  }
})

test('readStatus survives a catalogue the panel refuses, and says why', async () => {
  // Right after boot the pool is empty and /panel/api/models answers 503. The
  // chip must still render a pool count rather than an empty panel.
  const panel = await startPanel({ models: [], modelsStatus: 503 })
  try {
    const view = await readStatus(panel.port, 'sk-test')
    assert.equal(view.reachable, true)
    assert.deepEqual(view.freeModels, [])
    assert.equal(view.pool.total, 3, 'the pool read still succeeds')
    assert.match(view.error, /503/)
  } finally {
    await panel.close()
  }
})

test('readStatus reports an unreachable gateway without throwing', async () => {
  // A port nothing listens on: the chip needs a view it can render, not an
  // exception that breaks its poll loop.
  const view = await readStatus(1, 'sk-test', 1000)
  assert.equal(view.reachable, false)
  assert.notEqual(view.error, '')
  assert.deepEqual(view.freeModels, [])
  assert.equal(view.pool.total, 0)
})

test('an unreachable view keeps the panel URL so the chip stays actionable', () => {
  const view = unreachableView(7863, 'boom')
  assert.equal(view.reachable, false)
  assert.equal(view.panelUrl, 'http://127.0.0.1:7863/panel/')
  assert.equal(view.error, 'boom')
})
