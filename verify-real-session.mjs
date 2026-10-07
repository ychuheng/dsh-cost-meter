/**
 * Cross-check: price a real session from its canonical log and compare against
 * the balance the account actually lost.
 *
 * The log is written incrementally, so each durable flush appends its own
 * independent zstd frame; a single decompress yields only the first. This walks
 * every frame and concatenates them.
 *
 * Run with: node verify-real-session.mjs <session.v3.jsonl.zstd> [balanceBeforeCny]
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { costOfCall, formatCny, usdToCny, roundUsd } from './lib/pricing.js'

const path = process.argv[2]
const balanceBefore = process.argv[3] === undefined ? undefined : Number.parseFloat(process.argv[3])
const balanceAfter = process.argv[4] === undefined ? undefined : Number.parseFloat(process.argv[4])
const RATE = 6.721845

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const raw = readFileSync(path)
const starts = []
for (let i = 0; i + 4 <= raw.length; i += 1) {
  if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) starts.push(i)
}
console.log(`zstd frames found: ${starts.length}`)

const chunks = []
let failed = 0
for (let i = 0; i < starts.length; i += 1) {
  const from = starts[i]
  const to = i + 1 < starts.length ? starts[i + 1] : raw.length
  try {
    chunks.push(zstdDecompressSync(raw.subarray(from, to)))
  } catch {
    // A magic sequence can appear inside compressed bytes; a slice that does
    // not decompress is such a false positive rather than a damaged frame.
    failed += 1
  }
}
console.log(`frames decompressed: ${chunks.length}   false-positive magics skipped: ${failed}`)

const text = Buffer.concat(chunks).toString('utf8')
const lines = text.split('\n').filter((line) => line.trim().length > 0)
console.log(`log lines: ${lines.length}`)

const events = []
let unparseable = 0
for (const line of lines) {
  try {
    events.push(JSON.parse(line))
  } catch {
    unparseable += 1
  }
}
console.log(`parsed events: ${events.length}   unparseable: ${unparseable}`)

let usd = 0
let model
const unpriceable = new Set()
let peak = 0
let offPeak = 0
const buckets = { hit: 0, miss: 0, out: 0 }
const models = new Map()

for (const event of events) {
  if (event.type === 'request/header') {
    const named = event.data?.header?.config?.model
    if (typeof named === 'string') model = named
    continue
  }
  if (event.type !== 'assistant/message') continue
  const usage = event.data?.usage
  if (usage === undefined) continue
  if (model === undefined) {
    unpriceable.add('(no header)')
    continue
  }
  const priced = costOfCall(usage, model, event.time)
  if (priced === undefined) {
    unpriceable.add(model)
    continue
  }
  if (priced.peak) peak += 1
  else offPeak += 1
  usd = roundUsd(usd + priced.usd)
  buckets.hit += priced.tokens.cacheHitInput
  buckets.miss += priced.tokens.cacheMissInput
  buckets.out += priced.tokens.output
  models.set(model, (models.get(model) ?? 0) + 1)
}

const times = events.filter((e) => typeof e.time === 'number').map((e) => e.time)
console.log('')
console.log(`models       : ${[...models.entries()].map(([m, n]) => `${m} x${n}`).join(', ') || '(none)'}`)
console.log(`priced calls : ${peak + offPeak}  (peak ${peak}, off-peak ${offPeak})`)
console.log(`tokens       : hit ${buckets.hit.toLocaleString('en-US')} / miss ${buckets.miss.toLocaleString('en-US')} / out ${buckets.out.toLocaleString('en-US')}`)
if (times.length > 0) {
  console.log(`window       : ${new Date(Math.min(...times)).toISOString()}`)
  console.log(`            .. ${new Date(Math.max(...times)).toISOString()}`)
}
if (unpriceable.size > 0) console.log(`UNPRICEABLE  : ${[...unpriceable].join(', ')}`)

const cny = usdToCny(usd, RATE)
console.log('')
console.log(`computed cost: $${usd.toFixed(6)} = CNY ${formatCny(cny)}  (at ${RATE})`)

if (balanceBefore !== undefined) {
  const after = balanceAfter ?? 14.63
  const expected = balanceBefore - after
  console.log('')
  console.log(`balance before : ${balanceBefore.toFixed(2)} CNY`)
  console.log(`balance after  : ${after.toFixed(2)} CNY`)
  console.log(`actually spent : ${formatCny(expected)} CNY`)
  console.log(`computed       : ${formatCny(cny)} CNY`)
  console.log(`ratio computed/actual: ${expected === 0 ? 'n/a' : (cny / expected).toFixed(3)}`)
}
