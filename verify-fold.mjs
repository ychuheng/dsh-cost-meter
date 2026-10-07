/**
 * Verification for the host half: the session cost fold.
 *
 * Run with: node verify-fold.mjs
 *
 * The property that matters most here is per-call peak attribution: a session
 * that spans a peak boundary must price each call at its own instant's rate, not
 * at a single session-wide rate.
 */
import { foldSessionCost, inject, name } from './lib/index.js'

let failures = 0

function check(label, actual, expected) {
  const ok = Object.is(actual, expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`      expected ${expected}, got ${actual}`)
}

function checkClose(label, actual, expected, tolerance = 1e-12) {
  const ok = Math.abs(actual - expected) <= tolerance
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`      expected ${expected}, got ${actual}`)
}

/** 2026-09-16 is a Wednesday. */
const utc = (day, hour, minute = 0) => Date.UTC(2026, 8, day, hour, minute)

/** One assistant message carrying usage, stamped at `time`. */
const assistant = (time, usage) => ({ type: 'assistant/message', time, data: { usage } })
/** One request header naming the routed model. */
const header = (time, model) => ({ type: 'request/header', time, data: { header: { config: { provider: 'deepseek-official', model } } } })

console.log('--- module surface ---')
check('plugin name', name, 'cost-meter')
check('declares commands dependency', inject.includes('commands'), true)

console.log('--- empty and degenerate input ---')
const empty = foldSessionCost([])
check('empty log costs zero', empty.usd, 0)
check('empty log has no calls', empty.calls.priced, 0)
check('empty log reports nothing unpriceable', empty.unpriceable.length, 0)

console.log('--- one call, attributed to the nearest preceding header ---')
const one = foldSessionCost([
  header(utc(16, 5), 'deepseek-flash'),
  assistant(utc(16, 5), { inputTokens: 1_000_000, outputTokens: 0 }),
])
checkClose('1M uncached input off-peak = $0.15', one.usd, 0.15)
check('attributed to the routed model', one.perModel[0].model, 'deepseek-flash')

const onePeak = foldSessionCost([
  header(utc(16, 2), 'deepseek-flash'),
  assistant(utc(16, 2), { inputTokens: 1_000_000, outputTokens: 0 }),
])
checkClose('same tokens at peak = $0.30', onePeak.usd, 0.3)

console.log('--- PEAK BOUNDARY: one session, calls on both sides ---')
// DeepSeek peak ends at 04:00 UTC; 05:00 is off-peak, 02:00 is peak.
const straddling = foldSessionCost([
  header(utc(16, 2), 'deepseek-flash'),
  assistant(utc(16, 2), { inputTokens: 1_000_000, outputTokens: 0 }), // $0.30 peak
  header(utc(16, 5), 'deepseek-flash'),
  assistant(utc(16, 5), { inputTokens: 1_000_000, outputTokens: 0 }), // $0.15 off-peak
])
checkClose('straddling session sums per-call rates', straddling.usd, 0.45)
check('one peak call counted', straddling.calls.peak, 1)
check('one off-peak call counted', straddling.calls.offPeak, 1)
checkClose(
  'a single session-wide rate would have been wrong',
  straddling.usd,
  0.45,
)
// If the fold had used one rate for the whole session the answer would be
// 2 x 0.15 = 0.30 or 2 x 0.30 = 0.60, never 0.45.
check('and 0.45 differs from both uniform-rate answers', straddling.usd !== 0.3 && straddling.usd !== 0.6, true)

console.log('--- unpriceable models are excluded AND reported ---')
const mixed = foldSessionCost([
  header(utc(16, 5), 'deepseek-flash'),
  assistant(utc(16, 5), { inputTokens: 1_000_000, outputTokens: 0 }),
  header(utc(16, 5), 'some-other-model'),
  assistant(utc(16, 5), { inputTokens: 1_000_000, outputTokens: 0 }),
])
checkClose('only the priceable call is charged', mixed.usd, 0.15)
check('the unpriceable model is named', mixed.unpriceable[0], 'some-other-model')
check('only one call was priced', mixed.calls.priced, 1)

console.log('--- calls with no usage are skipped, not charged ---')
const noUsage = foldSessionCost([
  header(utc(16, 5), 'deepseek-flash'),
  { type: 'assistant/message', time: utc(16, 5), data: {} },
  assistant(utc(16, 5), { inputTokens: 1_000_000, outputTokens: 0 }),
])
checkClose('usage-less message contributes nothing', noUsage.usd, 0.15)
check('and is not counted as a priced call', noUsage.calls.priced, 1)

console.log('--- a message before any header is unpriceable, not free ---')
const headless = foldSessionCost([assistant(utc(16, 5), { inputTokens: 1_000_000, outputTokens: 0 })])
check('no header means no charge', headless.usd, 0)
check('and the gap is reported', headless.unpriceable.length, 1)

console.log('--- all three buckets are summed, none treated as a subtotal ---')
const allBuckets = foldSessionCost([
  header(utc(16, 5), 'deepseek-flash'),
  assistant(utc(16, 5), {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 0,
  }),
])
// off-peak flash: miss 0.15 + output 0.60 + cache-hit 0.003 = 0.753
checkClose('disjoint buckets sum correctly', allBuckets.usd, 0.753)
check('bucket totals are reported', allBuckets.buckets.cacheHitInput, 1_000_000)

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
