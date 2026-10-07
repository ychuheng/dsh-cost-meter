/**
 * Pricing core for dsh-cost-meter.
 *
 * This module is deliberately browser-safe and dependency-free: the Host half
 * imports it directly, and the Host also serves it verbatim at
 * `/cost-meter/pricing.js` so the browser half can `import()` the very same file
 * instead of keeping a second copy of the rate table. One source of truth is
 * what stops the displayed cost from drifting away from the billed cost.
 *
 * DeepSeek prices in USD per 1M tokens, and the table is two-dimensional beyond
 * the token bucket: every bucket carries a PEAK and an OFF-PEAK rate, with
 * off-peak exactly half of peak. Peak hours are 01:00-04:00 and 06:00-10:00 UTC,
 * Monday through Friday; every other instant is off-peak.
 *
 * All money is accumulated in USD here and converted to CNY only for display.
 * Never restate history at a newer rate: only the presentation layer converts.
 */

/** Price table revision and the date the rates below were read from the docs. */
export const PRICING_REVISION = {
  source: 'https://api-docs.deepseek.com/quick_start/pricing',
  readOn: '2026-09-18',
}

/**
 * Peak rates in USD per 1M tokens. Off-peak is derived as exactly half, which is
 * the relationship the official table states, so only one series is stored and
 * the two can never drift apart through a transcription error.
 */
const PEAK_RATES_PER_MILLION = {
  'deepseek-flash': {
    cacheHitInput: 0.006,
    cacheMissInput: 0.3,
    output: 1.2,
  },
  'deepseek-v4-pro': {
    cacheHitInput: 0.044,
    cacheMissInput: 1.32,
    output: 3.96,
  },
}

/** Off-peak is half of peak, per the official table. */
const OFF_PEAK_FACTOR = 0.5

/** Legacy model ids still accepted by the endpoint and billed at the Flash price. */
const ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
}

const TOKENS_PER_MILLION = 1_000_000

/** Every model id this revision can price. */
export function pricedModels() {
  return Object.keys(PEAK_RATES_PER_MILLION)
}

/**
 * Resolve one model id to an entry in the rate table, or undefined when unpriceable.
 *
 * @param model - provider model id.
 * @param overrides - optional live peak rates keyed by model, read from the
 *   official pricing page. When a model is present there its figures win, so a
 *   price change reaches the display without a code edit; the embedded table is
 *   the fallback for an unreadable page and for models the page does not list.
 */
export function resolveRates(model, overrides) {
  if (typeof model !== 'string') return undefined
  const canonical = ALIASES[model] ?? model
  const live = overrides?.[canonical] ?? overrides?.[model]
  if (live !== undefined && isCompleteRate(live)) return live
  return PEAK_RATES_PER_MILLION[canonical]
}

/** Whether one live rate entry carries every bucket at a usable value. */
function isCompleteRate(rate) {
  return (
    rate !== null &&
    typeof rate === 'object' &&
    Number.isFinite(rate.cacheHitInput) &&
    Number.isFinite(rate.cacheMissInput) &&
    Number.isFinite(rate.output)
  )
}

/**
 * Whether an instant falls in a DeepSeek peak window.
 *
 * Windows are 01:00-04:00 and 06:00-10:00 UTC on Monday-Friday. Evaluation is
 * on the UTC clock; a caller's local timezone must never enter this decision,
 * because the published windows are UTC and the bill follows the provider's clock.
 *
 * @param epochMs - Unix epoch milliseconds of the request being priced.
 * @returns true when the instant is billed at the peak rate.
 */
export function isPeak(epochMs) {
  const at = new Date(epochMs)
  const day = at.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = at.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

/**
 * Price one model call.
 *
 * Token buckets are DISJOINT: `uncachedInputTokens` is uncached input only, and
 * cached input arrives separately, so the three buckets are summed rather than
 * one being a subtotal of another.
 *
 * @param usage - the four disjoint provider-reported token buckets.
 * @param model - provider model id as it appears in the request header.
 * @param epochMs - the call's instant, used to select peak or off-peak rates.
 * @param overrides - optional live peak rates keyed by model.
 * @returns USD cost plus the facts the display needs, or undefined when the model
 *   has no configured rate. An unpriceable call yields NO cost rather than zero:
 *   a silent zero would understate the total without any visible symptom.
 */
export function costOfCall(usage, model, epochMs, overrides) {
  const rates = resolveRates(model, overrides)
  if (rates === undefined) return undefined
  if (usage === undefined || usage === null) return undefined

  const peak = isPeak(epochMs)
  const factor = peak ? 1 : OFF_PEAK_FACTOR

  const cacheHitInput = numberOrZero(usage.cacheReadTokens) + numberOrZero(usage.cacheWriteTokens)
  const cacheMissInput = numberOrZero(usage.inputTokens)
  const output = numberOrZero(usage.outputTokens)

  const usd =
    ((cacheHitInput * rates.cacheHitInput * factor) +
      (cacheMissInput * rates.cacheMissInput * factor) +
      (output * rates.output * factor)) /
    TOKENS_PER_MILLION

  return {
    usd,
    peak,
    model,
    tokens: {
      cacheHitInput,
      cacheMissInput,
      output,
      total: cacheHitInput + cacheMissInput + output,
    },
  }
}

/**
 * Price a whole-session token total.
 *
 * The session projection reports one aggregate per bucket and no per-call
 * timing, so a single peak decision is applied to every bucket. That is exact
 * for a session that stays on one side of a peak boundary, and an approximation
 * for one that straddles it — the caller is expected to label it as such rather
 * than imply per-call precision the aggregate cannot support.
 *
 * @param totals - the session projection's bucket totals.
 * @param model - the model to price at, or undefined when unknown.
 * @param epochMs - the instant whose peak/off-peak rate applies.
 * @param overrides - optional live peak rates keyed by model.
 * @returns a priced result, or undefined when the model is unpriceable.
 */
export function costOfTotals(totals, model, epochMs, overrides) {
  if (totals === undefined || totals === null) return undefined
  return costOfCall(
    {
      // The projection names the uncached bucket `uncachedInputTokens`; the
      // per-call usage record names the same quantity `inputTokens`.
      inputTokens: totals.uncachedInputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
    },
    model,
    epochMs,
    overrides,
  )
}

/**
 * Round a USD amount for accumulation.
 *
 * Accumulate at higher precision than is ever displayed so that a long session of
 * sub-cent calls does not lose value to repeated rounding.
 */
export function roundUsd(usd) {
  return Math.round(usd * 1e10) / 1e10
}

/** Convert an accumulated USD amount to CNY for display. */
export function usdToCny(usd, rate) {
  if (!Number.isFinite(rate) || rate <= 0) return undefined
  return usd * rate
}

/**
 * Format CNY with enough precision to show a partial cent without lying about it.
 *
 * A session that has cost a fraction of a fen must not render as "¥0.00", which
 * reads as "this was free". Small non-zero amounts therefore keep four decimals.
 *
 * @param cny - amount in CNY.
 * @returns display text without the currency symbol.
 */
export function formatCny(cny) {
  if (!Number.isFinite(cny)) return '?'
  if (cny === 0) return '0.00'
  const magnitude = Math.abs(cny)
  if (magnitude < 0.01) return cny.toFixed(4)
  return cny.toFixed(2)
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
