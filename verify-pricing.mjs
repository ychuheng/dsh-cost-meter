/**
 * Verification for the pricing core.
 *
 * Run with: node verify-pricing.mjs
 *
 * This checks the arithmetic against real token totals taken from a stored
 * session projection, and pins the peak-window boundaries so a future edit to
 * `isPeak` cannot silently shift what gets billed at double.
 */
import {
  costOfCall,
  isPeak,
  resolveRates,
  formatCny,
  usdToCny,
  roundUsd,
} from './lib/pricing.js'

let failures = 0

function check(label, actual, expected) {
  const ok = Object.is(actual, expected)
  if (!ok) failures += 1
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${label}`)
  if (!ok) console.log(`      expected ${expected}, got ${actual}`)
}

function checkClose(label, actual, expected, tolerance = 1e-12) {
  const ok = Math.abs(actual - expected) <= tolerance
  if (!ok) failures += 1
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${label}`)
  if (!ok) console.log(`      expected ${expected}, got ${actual}`)
}

// --- Peak window boundaries -------------------------------------------------
// 2026-09-16 is a Wednesday. All instants below are UTC.
const utc = (day, hour, minute = 0) =>
  Date.UTC(2026, 8, day, hour, minute)

console.log('--- peak windows (UTC Mon-Fri 01:00-04:00, 06:00-10:00) ---')
check('Wed 00:59 off-peak', isPeak(utc(16, 0, 59)), false)
check('Wed 01:00 peak', isPeak(utc(16, 1, 0)), true)
check('Wed 03:59 peak', isPeak(utc(16, 3, 59)), true)
check('Wed 04:00 off-peak', isPeak(utc(16, 4, 0)), false)
check('Wed 05:59 off-peak', isPeak(utc(16, 5, 59)), false)
check('Wed 06:00 peak', isPeak(utc(16, 6, 0)), true)
check('Wed 09:59 peak', isPeak(utc(16, 9, 59)), true)
check('Wed 10:00 off-peak', isPeak(utc(16, 10, 0)), false)
// 2026-09-19 is a Saturday, 2026-09-20 a Sunday.
check('Sat 02:00 off-peak (weekend)', isPeak(utc(19, 2, 0)), false)
check('Sun 07:00 off-peak (weekend)', isPeak(utc(20, 7, 0)), false)

// --- Off-peak is exactly half of peak --------------------------------------
console.log('--- off-peak factor ---')
const usage = { inputTokens: 1_000_000, outputTokens: 0 }
const peakCost = costOfCall(usage, 'deepseek-flash', utc(16, 2, 0)).usd
const offCost = costOfCall(usage, 'deepseek-flash', utc(16, 5, 0)).usd
checkClose('1M uncached input at peak = $0.30', peakCost, 0.3)
checkClose('1M uncached input off-peak = $0.15', offCost, 0.15)
checkClose('off-peak is exactly half of peak', offCost * 2, peakCost)

// --- Rate table matches the published table --------------------------------
console.log('--- published rates ---')
const flash = resolveRates('deepseek-flash')
check('flash peak cache-hit', flash.cacheHitInput, 0.006)
check('flash peak cache-miss', flash.cacheMissInput, 0.3)
check('flash peak output', flash.output, 1.2)
const pro = resolveRates('deepseek-v4-pro')
check('pro peak cache-hit', pro.cacheHitInput, 0.044)
check('pro peak cache-miss', pro.cacheMissInput, 1.32)
check('pro peak output', pro.output, 3.96)
check('legacy alias maps to flash', resolveRates('deepseek-v4-flash').output, 1.2)
check('unknown model is unpriceable', resolveRates('gpt-4o'), undefined)

// --- Unpriceable calls must not become zero --------------------------------
console.log('--- unpriceable handling ---')
check('unknown model yields undefined, not 0', costOfCall(usage, 'gpt-4o', utc(16, 2, 0)), undefined)
check('missing usage yields undefined', costOfCall(undefined, 'deepseek-flash', utc(16, 2, 0)), undefined)

// --- Real session totals ----------------------------------------------------
// Session 6d617084 / session-6d617084-c024-4e71-b64d-ee2f8342b4ee.json
// tokenUsage.totals: uncachedInput 44183, output 12234, cacheRead 1330816, cacheWrite 0
const real = {
  inputTokens: 44_183,
  outputTokens: 12_234,
  cacheReadTokens: 1_330_816,
  cacheWriteTokens: 0,
}
const realPeak = costOfCall(real, 'deepseek-flash', utc(16, 2, 0))
const realOff = costOfCall(real, 'deepseek-flash', utc(16, 5, 0))

console.log('--- real session 6d617084 (deepseek-flash) ---')
check('token total reconciles', realPeak.tokens.total, 44_183 + 12_234 + 1_330_816)
console.log(`      peak     USD ${realPeak.usd.toFixed(6)}`)
console.log(`      off-peak USD ${realOff.usd.toFixed(6)}`)
console.log(`      at rate 6.721845: peak CNY ${formatCny(usdToCny(realPeak.usd, 6.721845))}`)

// The whole session ran entirely inside one peak window, so the honest check is
// that peak is exactly twice off-peak for identical tokens.
checkClose('same tokens: peak is 2x off-peak', realPeak.usd, realOff.usd * 2)
check('cache-hit dominance means tiny money', realOff.usd < 0.02, true)

// --- a live table overrides the embedded one, and only when complete --------
console.log('--- live rate overrides ---')
const complete = { cacheHitInput: 0.01, cacheMissInput: 0.5, output: 2.0 }
check('a complete live entry wins', resolveRates('deepseek-flash', { 'deepseek-flash': complete }).output, 2.0)
checkClose(
  'and changes the priced result',
  costOfCall({ inputTokens: 1_000_000, outputTokens: 0 }, 'deepseek-flash', utc(16, 2, 0), { 'deepseek-flash': complete }).usd,
  0.5,
)
check(
  'an INCOMPLETE live entry is ignored for the embedded one',
  resolveRates('deepseek-flash', { 'deepseek-flash': { output: 9 } }).output,
  1.2,
)
check('a null live table falls back', resolveRates('deepseek-flash', null).output, 1.2)
check('an absent live model falls back', resolveRates('deepseek-flash', { 'other': complete }).output, 1.2)

// --- accumulation precision -------------------------------------------------
console.log('--- accumulation ---')
let total = 0
const oneCall = costOfCall({ inputTokens: 900, outputTokens: 120 }, 'deepseek-flash', utc(16, 5, 0)).usd
for (let i = 0; i < 10_000; i += 1) total = roundUsd(total + oneCall)
checkClose('10000 accumulated calls stay exact', total, oneCall * 10_000, 1e-9)
console.log(`      per-call USD ${oneCall.toExponential(6)}`)

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
