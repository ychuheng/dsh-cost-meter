/**
 * Offline-degradation verification.
 *
 * Run with: node verify-offline.mjs
 *
 * Acceptance says a network outage must not affect the conversation or the cost
 * readout. This drives every network-touching path in the plugin with a fetch
 * that always fails, and asserts three things:
 *
 *   1. nothing THROWS 鈥?a throw from a route handler is what would surface as a
 *      broken request, and a throw during command handling would surface as a
 *      failed command;
 *   2. every failure is REPORTED as a structured value, so the surface can say
 *      "unavailable" instead of silently rendering a zero;
 *   3. the cost arithmetic, which is pure and local, is completely unaffected.
 */
import { readBalance, readUsdCnyRate } from './lib/balance.js'
import { readLivePricing } from './lib/live-pricing.js'
import { costOfCall, costOfTotals, usdToCny, formatCny } from './lib/pricing.js'
import { foldSessionCost } from './lib/index.js'

let failures = 0

function check(label, actual, expected) {
  const ok = Object.is(actual, expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`      expected ${expected}, got ${actual}`)
}

function checkTruthy(label, value) {
  const ok = Boolean(value)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}

/** Install a fetch that fails every request, and restore it afterwards. */
const realFetch = globalThis.fetch
function withBrokenNetwork(run) {
  globalThis.fetch = async () => {
    const error = new TypeError('fetch failed: network is unreachable')
    throw error
  }
  return Promise.resolve(run()).finally(() => {
    globalThis.fetch = realFetch
  })
}

/** A minimal host context: credentials absent, so resolution falls through to env. */
const ctx = { reflect: { get: () => undefined } }

console.log('--- a failing network never throws ---')

// The plugin must not declare a credential in the environment for this path, or
// the balance read would get past its first guard; the name is unique on purpose.
delete process.env.COST_METER_OFFLINE_KEY

const balance = await withBrokenNetwork(() => readBalance(ctx, { apiKeyEnv: 'COST_METER_OFFLINE_KEY' }))
check('readBalance returns rather than throws', typeof balance, 'object')
check('readBalance reports failure', balance.ok, false)
check('and names the missing credential, not a crash', balance.reason, 'credential-missing')

// With a credential present, the failing network is what must be reported.
process.env.COST_METER_OFFLINE_KEY = 'sk-not-a-real-key'
const balance2 = await withBrokenNetwork(() => readBalance(ctx, { apiKeyEnv: 'COST_METER_OFFLINE_KEY' }))
check('readBalance with a key reports the network failure', balance2.ok, false)
check('and classifies it as a transport problem', balance2.reason, 'network')
delete process.env.COST_METER_OFFLINE_KEY

const rateCache = { value: undefined }
const rate = await withBrokenNetwork(() => readUsdCnyRate(rateCache))
check('readUsdCnyRate returns rather than throws', typeof rate, 'object')
check('readUsdCnyRate reports failure', rate.ok, false)
check('and classifies it as a transport problem', rate.reason, 'network')

const pricingCache = { value: undefined }
const live = await withBrokenNetwork(() => readLivePricing(pricingCache))
check('readLivePricing returns rather than throws', typeof live, 'object')
check('readLivePricing reports failure', live.ok, false)
check('and classifies it as a transport problem', live.reason, 'network')

console.log('--- an aborted request degrades instead of hanging or throwing ---')

// A HANGING network is the realistic failure: the provider accepts the
// connection and never answers. That path is the AbortController timeout, and a
// caller signal that is already aborted must take it immediately rather than
// waiting out the clock.
process.env.COST_METER_OFFLINE_KEY = 'sk-not-a-real-key'
const aborted = new AbortController()
aborted.abort()

const abortedBalance = await readBalance(ctx, {
  apiKeyEnv: 'COST_METER_OFFLINE_KEY',
  signal: aborted.signal,
})
check('an aborted balance read degrades rather than throwing', typeof abortedBalance, 'object')
check('and reports a timeout-class failure', abortedBalance.reason, 'timeout')

const abortedRate = await readUsdCnyRate({ value: undefined }, aborted.signal)
check('the rate read degrades on an aborted signal', abortedRate.ok, false)
check('and classifies it as a timeout', abortedRate.reason, 'timeout')

const abortedPricing = await readLivePricing({ value: undefined }, aborted.signal)
check('the price read degrades on an aborted signal', abortedPricing.ok, false)
check('and classifies it as a timeout', abortedPricing.reason, 'timeout')
delete process.env.COST_METER_OFFLINE_KEY

console.log('--- a cache serves the last good value when the network dies ---')

// Seed each cache with a value that is already PAST its TTL. A fresh cache
// would take the "still cached" branch and never touch the network at all, so
// only an expired entry actually exercises the outage fallback.
const EXPIRED = Date.now() - 25 * 60 * 60 * 1000

const seededRate = { value: { rate: 6.721845, fetchedAt: EXPIRED, source: 'test' } }
const staleRate = await withBrokenNetwork(() => readUsdCnyRate(seededRate))
check('an expired cached rate is still served offline', staleRate.ok, true)
check('and is flagged stale', staleRate.stale, true)
check('with the number intact', staleRate.rate, 6.721845)
checkTruthy('and carries the failure that forced the fallback', staleRate.failure !== undefined)

const seededPricing = {
  value: {
    models: ['deepseek-flash'],
    rates: { 'deepseek-flash': { cacheHitInput: 0.006, cacheMissInput: 0.3, output: 1.2 } },
    offPeak: { 'deepseek-flash': { cacheHitInput: 0.003, cacheMissInput: 0.15, output: 0.6 } },
    fetchedAt: EXPIRED,
    source: 'test',
  },
}
const stalePricing = await withBrokenNetwork(() => readLivePricing(seededPricing))
check('an expired cached price table is still served offline', stalePricing.ok, true)
check('and is flagged stale', stalePricing.stale, true)
checkTruthy('and carries the failure that forced the fallback', stalePricing.failure !== undefined)

console.log('--- cost arithmetic is local, so it is untouched by an outage ---')

// The same fold, run while the network is down, must produce the identical
// figure it produces with the network up. This is the property that makes the
// cost readout survive an outage at all.
const events = [
  { type: 'request/header', time: Date.UTC(2026, 8, 16, 5), data: { header: { config: { model: 'deepseek-flash' } } } },
  { type: 'assistant/message', time: Date.UTC(2026, 8, 16, 5), data: { usage: { inputTokens: 1_000_000, outputTokens: 0 } } },
]
const online = foldSessionCost(events)
const offline = await withBrokenNetwork(() => foldSessionCost(events))
check('fold works with the network up', online.usd, 0.15)
check('fold works with the network down', offline.usd, 0.15)
check('and the two agree exactly', offline.usd, online.usd)

// Conversion is pure arithmetic over a value already in hand, so it needs no
// network either; only obtaining the rate does.
const cny = usdToCny(offline.usd, 6.721845)
check('conversion still works offline given a rate', formatCny(cny), '1.01')

// The projection-shaped input must price identically, since that is what the
// browser half actually feeds the core.
const projected = { uncachedInputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
const fromProjection = costOfTotals(projected, 'deepseek-flash', Date.UTC(2026, 8, 16, 5))
check('the browser projection shape prices the same', fromProjection.usd, 0.15)

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
