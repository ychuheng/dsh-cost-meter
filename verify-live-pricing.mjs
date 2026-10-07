/**
 * Verification for the live price-table reader.
 *
 * Run with: node verify-live-pricing.mjs
 *
 * Three things matter here:
 *   1. the parser reads the real page into the right models and buckets;
 *   2. what it reads AGREES with the embedded table, so the two cannot silently
 *      diverge and leave the display wrong;
 *   3. a page it cannot fully parse yields NOTHING rather than a guessed table,
 *      because a wrong price is worse than a visibly stale one.
 */
import { parsePricingPage, readLivePricing } from './lib/live-pricing.js'
import { resolveRates, pricedModels } from './lib/pricing.js'

let failures = 0

function check(label, actual, expected) {
  const ok = Object.is(actual, expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`      expected ${expected}, got ${actual}`)
}

function checkClose(label, actual, expected) {
  const ok = typeof actual === 'number' && Math.abs(actual - expected) < 1e-9
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`      expected ${expected}, got ${actual}`)
}

// --- failure handling must never invent a table ----------------------------
console.log('--- unparseable input yields nothing ---')
check('empty string', parsePricingPage(''), undefined)
check('unrelated html', parsePricingPage('<html><body><p>hello</p></body></html>'), undefined)
check(
  'a page with the model header but no pricing rows',
  parsePricingPage('<td>MODEL</td><td>deepseek-flash</td><td>BASE URL</td>'),
  undefined,
)
check(
  'a pricing section missing the OFF-PEAK label',
  parsePricingPage('<td>MODEL</td><td>deepseek-flash</td><td>BASE URL</td><td>1M OUTPUT TOKENS</td><td>$0.6</td>'),
  undefined,
)
check(
  'a row with the wrong number of money columns',
  parsePricingPage(
    '<td>MODEL</td><td>deepseek-flash</td><td>BASE URL</td>' +
      '<td>1M INPUT TOKENS (CACHE HIT)</td><td>OFF-PEAK</td><td>$0.003</td><td>PEAK</td><td>$0.006</td>' +
      '<td>1M INPUT TOKENS (CACHE MISS)</td><td>OFF-PEAK</td><td>$0.15</td><td>PEAK</td><td>$0.3</td>' +
      // Last section carries only one column while two models were declared.
      '<td>1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.6</td><td>PEAK</td><td>$1.2</td>',
  ),
  undefined,
)

// --- the parser reads a faithful synthetic page ----------------------------
// Row shape mirrors the real markup exactly, including the trap that the first
// pricing row carries the bucket label and OFF-PEAK in the SAME cell while the
// later buckets put the label in a cell of its own.
console.log('--- a well-formed page parses completely ---')
const synthetic =
  '<table>' +
  '<tr><td>MODEL</td><td>deepseek-flash (1)</td><td>deepseek-v4-pro (2)</td></tr>' +
  '<tr><td>BASE URL (OpenAI Format)</td><td>https://api.deepseek.com</td></tr>' +
  '<tr><td>MODEL VERSION</td><td>DeepSeek-V4.1-Flash</td><td>DeepSeek-V4-Pro-0813</td></tr>' +
  '<tr><td>PRICING (3)</td><td>1M INPUT TOKENS (CACHE HIT)</td><td>OFF-PEAK</td><td>$0.003</td><td>$0.022</td></tr>' +
  '<tr><td>PEAK</td><td>$0.006</td><td>$0.044</td></tr>' +
  '<tr><td>1M INPUT TOKENS (CACHE MISS)</td><td>OFF-PEAK</td><td>$0.15</td><td>$0.66</td></tr>' +
  '<tr><td>PEAK</td><td>$0.3</td><td>$1.32</td></tr>' +
  '<tr><td>1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>$0.6</td><td>$1.98</td></tr>' +
  '<tr><td>PEAK</td><td>$1.2</td><td>$3.96</td></tr>' +
  '<tr><td>Concurrency Limit (4)</td><td>2500</td><td>500</td></tr>' +
  '</table>'

const parsed = parsePricingPage(synthetic)
check('parses a complete table', parsed !== undefined, true)
if (parsed !== undefined) {
  check('both models found in column order', parsed.models.join(','), 'deepseek-flash,deepseek-v4-pro')
  checkClose('flash peak cache-hit', parsed.rates['deepseek-flash'].cacheHitInput, 0.006)
  checkClose('flash peak cache-miss', parsed.rates['deepseek-flash'].cacheMissInput, 0.3)
  checkClose('flash peak output', parsed.rates['deepseek-flash'].output, 1.2)
  checkClose('pro peak cache-hit', parsed.rates['deepseek-v4-pro'].cacheHitInput, 0.044)
  checkClose('pro peak cache-miss', parsed.rates['deepseek-v4-pro'].cacheMissInput, 1.32)
  checkClose('pro peak output', parsed.rates['deepseek-v4-pro'].output, 3.96)
  // off-peak is also read, purely so the test can prove the two agree.
  checkClose('flash off-peak output is half of peak', parsed.offPeak['deepseek-flash'].output * 2, parsed.rates['deepseek-flash'].output)
  checkClose('pro off-peak output is half of peak', parsed.offPeak['deepseek-v4-pro'].output * 2, parsed.rates['deepseek-v4-pro'].output)
}

// --- the live page, and agreement with the embedded table ------------------
console.log('--- the real pricing page ---')
const cache = { value: undefined }
const live = await readLivePricing(cache)
if (live.ok !== true) {
  // A network failure must not fail this suite; it must be visibly reported.
  console.log(`SKIP  live page unreachable (${live.reason}: ${live.message})`)
  console.log('      the embedded table remains the fallback, which is the designed behavior')
} else {
  check('live read is not stale', live.stale === true, false)
  check('live read names its source', typeof live.source, 'string')
  check('live read carries a fetch time', typeof live.fetchedAt, 'number')
  console.log(`      models: ${live.models.join(', ')}`)

  // THE load-bearing assertion: live and embedded must agree. A disagreement
  // means one of the two is wrong and the displayed cost is wrong with it.
  for (const model of live.models) {
    const embedded = resolveRates(model)
    if (embedded === undefined) {
      console.log(`SKIP  ${model}: not in the embedded table (new model 鈥?add it to pricing-core.mjs)`)
      continue
    }
    for (const bucket of ['cacheHitInput', 'cacheMissInput', 'output']) {
      checkClose(`live and embedded agree on ${model}.${bucket}`, live.rates[model][bucket], embedded[bucket])
    }
  }

  // Every embedded model should still be priced by the live page.
  for (const model of pricedModels()) {
    check(`embedded model ${model} still appears live`, live.models.includes(model), true)
  }
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
