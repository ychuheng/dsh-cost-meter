/**
 * dsh-cost-meter, host half.
 *
 * Reads the conversation's cost from locally logged provider usage and reads the
 * DeepSeek account balance over the network. The browser half ships through
 * `exports["./client"]` and is discovered from this package's `dsh.client`
 * declaration.
 *
 * Division of labor:
 *   - Cost is LOCAL and always available: it folds durable session events.
 *   - Balance and rate are NETWORK reads, isolated so their failure cannot take
 *     the cost readout down with them.
 *
 * @module dsh-cost-meter
 */

import {
  DEFAULT_API_KEY_ENV,
  DEFAULT_BALANCE_BASE_URL,
  readBalance,
  readUsdCnyRate,
} from './balance.js'
import { readLivePricing } from './live-pricing.js'
import {
  PRICING_REVISION,
  costOfCall,
  formatCny,
  isPeak,
  resolveRates,
  roundUsd,
  usdToCny,
} from './pricing.js'

export const name = 'cost-meter'

/**
 * Host services this plugin uses.
 *
 * `commands` is required: without it there is nothing to register.
 * `webServer` is listed as a SOFT dependency — `apply` tolerates its absence so
 * the plugin still serves commands in a composition with no HTTP carrier.
 */
export const inject = ['commands']

/** Route the browser half reads its balance and rate from. Same origin, so the key stays on the Host. */
const BALANCE_ROUTE = '/cost-meter/balance'

/**
 * Route serving the shared pricing core to the browser.
 *
 * The browser half `import()`s this URL rather than carrying its own copy of the
 * rate table, so there is exactly one place where a price is written down. The
 * served bytes are `lib/pricing-core.mjs` verbatim.
 */
const PRICING_ROUTE = '/cost-meter/pricing.js'

/** Absolute path of the pricing core beside this module. */
const PRICING_FILE_URL = new URL('./pricing-core.mjs', import.meta.url)

/** The token buckets carried by one `assistant/message` usage record. */
function usageOf(event) {
  const usage = event?.data?.usage
  if (usage === undefined || usage === null) return undefined
  return usage
}

/**
 * Fold a session's durable events into a cost total.
 *
 * Attribution: each `assistant/message` is charged at the rate of the model named
 * by the nearest preceding `request/header`, and at the peak or off-peak rate of
 * its OWN timestamp rather than the session's. A conversation that spans a peak
 * boundary therefore prices each half correctly.
 *
 * @param events - the session's durable events in order.
 * @param overrides - optional live peak rates keyed by model; absent uses the embedded table.
 * @returns totals, a per-model breakdown, and any unpriceable models encountered.
 */
export function foldSessionCost(events, overrides) {
  let usd = 0
  let currentModel
  const buckets = { cacheHitInput: 0, cacheMissInput: 0, output: 0 }
  const perModel = new Map()
  const unpriceable = new Set()
  let peakCalls = 0
  let offPeakCalls = 0
  let pricedCalls = 0

  for (const event of events) {
    if (event?.type === 'request/header') {
      const model = event.data?.header?.config?.model
      if (typeof model === 'string') currentModel = model
      continue
    }
    if (event?.type !== 'assistant/message') continue

    const usage = usageOf(event)
    if (usage === undefined) continue

    const model = currentModel
    if (model === undefined) {
      unpriceable.add('(unknown model)')
      continue
    }
    const priced = costOfCall(usage, model, event.time, overrides)
    if (priced === undefined) {
      unpriceable.add(model)
      continue
    }

    pricedCalls += 1
    if (priced.peak) peakCalls += 1
    else offPeakCalls += 1

    usd = roundUsd(usd + priced.usd)
    buckets.cacheHitInput += priced.tokens.cacheHitInput
    buckets.cacheMissInput += priced.tokens.cacheMissInput
    buckets.output += priced.tokens.output

    const entry = perModel.get(model) ?? { model, usd: 0, calls: 0 }
    entry.usd = roundUsd(entry.usd + priced.usd)
    entry.calls += 1
    perModel.set(model, entry)
  }

  return {
    usd,
    buckets,
    perModel: [...perModel.values()].sort((a, b) => b.usd - a.usd),
    unpriceable: [...unpriceable],
    calls: { priced: pricedCalls, peak: peakCalls, offPeak: offPeakCalls },
  }
}

/**
 * Collect a session's durable events.
 *
 * `Session.snapshotEvents()` is the public read model: it answers the whole log,
 * so a command invoked mid-turn sees every settled call. A session whose log is
 * unavailable yields an empty list and the caller reports that, rather than
 * silently pricing the conversation at zero.
 */
function eventsOf(session) {
  try {
    if (typeof session?.snapshotEvents === 'function') {
      const events = session.snapshotEvents()
      if (Array.isArray(events)) return events
    }
  } catch {
    return []
  }
  return []
}

/**
 * Render the cost report as plain text for a human-facing command result.
 *
 * @param folded - result of {@link foldSessionCost}.
 * @param rate - current USD/CNY rate, or undefined when conversion is unavailable.
 * @param pricing - the live price-table readout, when one was attempted.
 * @returns display lines.
 */
function renderCost(folded, rate, pricing) {
  const lines = []
  const cny = rate === undefined ? undefined : usdToCny(folded.usd, rate)
  const money = cny === undefined ? `$${folded.usd.toFixed(6)}` : `¥${formatCny(cny)}`
  lines.push(`Session cost: ${money}`)
  if (cny !== undefined) {
    lines.push(`  ($${folded.usd.toFixed(6)} at ${rate.toFixed(4)} CNY/USD)`)
  } else {
    lines.push('  (no exchange rate available; showing USD)')
  }

  const total = folded.buckets.cacheHitInput + folded.buckets.cacheMissInput + folded.buckets.output
  lines.push('')
  lines.push(`Priced calls: ${folded.calls.priced}  (peak ${folded.calls.peak}, off-peak ${folded.calls.offPeak})`)
  lines.push('')
  lines.push('Tokens:')
  lines.push(`  cache-hit input : ${folded.buckets.cacheHitInput.toLocaleString('en-US')}`)
  lines.push(`  cache-miss input: ${folded.buckets.cacheMissInput.toLocaleString('en-US')}`)
  lines.push(`  output          : ${folded.buckets.output.toLocaleString('en-US')}`)
  lines.push(`  total           : ${total.toLocaleString('en-US')}`)

  if (folded.perModel.length > 0) {
    lines.push('')
    lines.push('By model:')
    for (const entry of folded.perModel) {
      const entryCny = rate === undefined ? undefined : usdToCny(entry.usd, rate)
      const shown = entryCny === undefined ? `$${entry.usd.toFixed(6)}` : `¥${formatCny(entryCny)}`
      lines.push(`  ${entry.model}: ${shown} over ${entry.calls} call(s)`)
    }
  }

  if (folded.unpriceable.length > 0) {
    lines.push('')
    lines.push(`NO RATE CONFIGURED for: ${folded.unpriceable.join(', ')} — these calls are EXCLUDED from the total.`)
    lines.push('Their true cost is higher than shown. A live table that lists the model fixes this automatically.')
  }

  lines.push('')
  if (pricing?.ok === true) {
    const when = new Date(pricing.fetchedAt).toISOString()
    lines.push(`Prices: LIVE from ${pricing.source} (read ${when}, models: ${pricing.models.join(', ')})${pricing.stale === true ? ' — STALE, last good read' : ''}`)
  } else if (pricing === undefined) {
    lines.push(`Prices: embedded table read ${PRICING_REVISION.readOn} from ${PRICING_REVISION.source}`)
  } else {
    lines.push(`Prices: embedded table read ${PRICING_REVISION.readOn} — the live page was not usable (${pricing.reason})`)
    lines.push(`  ${pricing.message}`)
  }
  return lines
}

/** Render the balance readout as plain text. */
function renderBalance(state) {
  if (state === undefined) return ['Balance: not read yet. Run /balance.']
  if (!state.ok) {
    return [
      'Balance: unavailable',
      `  reason: ${state.reason}`,
      `  ${state.message}`,
    ]
  }
  const { primary, entries } = state
  const lines = []
  const symbol = primary.currency === 'CNY' ? '¥' : primary.currency === 'USD' ? '$' : ''
  lines.push(`Balance: ${symbol}${primary.total.toFixed(2)} ${primary.currency}`)
  if (primary.granted !== undefined && primary.toppedUp !== undefined) {
    lines.push(`  granted: ${symbol}${primary.granted.toFixed(2)}   topped up: ${symbol}${primary.toppedUp.toFixed(2)}`)
  }
  if (entries.length > 1) {
    lines.push(`  other currencies: ${entries.filter((e) => e !== primary).map((e) => `${e.total} ${e.currency}`).join(', ')}`)
  }
  lines.push(`  available for calls: ${state.isAvailable ? 'yes' : 'NO'}`)
  lines.push(`  read at: ${new Date(state.fetchedAt).toISOString()}`)
  return lines
}

/**
 * Plugin body.
 *
 * @param ctx - host context carrying the command registry.
 * @param config - loader-supplied configuration; both fields fall back to the
 *   defaults so an unconfigured row still works.
 */
export function apply(ctx, config) {
  /** Latest balance readout, shared by the commands and the browser surface. */
  const state = { balance: undefined, rate: undefined, pricing: undefined, lastReadAt: undefined }
  /** Single-slot rate cache, owned here so it survives across reads. */
  const rateCache = { value: undefined }
  /** Single-slot live price-table cache. */
  const pricingCache = { value: undefined }
  /** Minimum spacing between automatic balance reads. */
  let lastBalanceReadAt = 0
  const MIN_READ_INTERVAL_MS = 60_000

  const settings = {
    balanceBaseURL: config?.balanceBaseURL ?? DEFAULT_BALANCE_BASE_URL,
    apiKeyEnv: config?.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
  }

  /** Read the balance unless the minimum interval has not yet elapsed. */
  async function refreshBalance(options = {}) {
    const now = Date.now()
    if (!options.force && now - lastBalanceReadAt < MIN_READ_INTERVAL_MS) {
      return state.balance
    }
    lastBalanceReadAt = now
    const result = await readBalance(ctx, { baseURL: settings.balanceBaseURL, apiKeyEnv: settings.apiKeyEnv })
    state.balance = result
    state.lastReadAt = now
    return result
  }

  /** Read the rate, reusing the cache inside its TTL. */
  async function refreshRate() {
    const result = await readUsdCnyRate(rateCache)
    if (result.ok) state.rate = result
    return result
  }

  /**
   * Read the official price table, reusing the cache inside its TTL.
   *
   * A read that cannot be parsed confidently is NOT applied: `state.pricing`
   * keeps the last good table (or none), and pricing falls back to the embedded
   * one. That is the whole reason a scrape is safe to do at all — a wrong price
   * would be invisible, a stale one is dated.
   */
  async function refreshPricing() {
    const result = await readLivePricing(pricingCache)
    if (result.ok) state.pricing = result
    return result
  }

  /** Live peak rates keyed by model, or undefined to price from the embedded table. */
  function currentRates() {
    return state.pricing?.ok === true ? state.pricing.rates : undefined
  }

  /** Current USD/CNY rate, or undefined when no conversion is available. */
  function currentRate() {
    return state.rate?.ok === true ? state.rate.rate : undefined
  }

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'cost',
      description: 'Show what this conversation has cost so far',
      handler: async (invocation) => {
        const session = invocation.agent?.session
        const events = eventsOf(session)
        if (events.length === 0) {
          return { kind: 'error', text: 'No session log available to price.' }
        }
        // Both reads are best-effort: a failure here falls back to the cached
        // value, then to the embedded price table and to USD, so the cost figure
        // stays available with the network down.
        await refreshRate()
        await refreshPricing()
        const folded = foldSessionCost(events, currentRates())
        return { kind: 'success', text: renderCost(folded, currentRate(), state.pricing).join('\n') }
      },
    })

    yield ctx.commands.register({
      name: 'balance',
      description: 'Read the current DeepSeek account balance',
      handler: async (invocation) => {
        const result = await refreshBalance({ force: true, signal: invocation.signal })
        await refreshRate()
        const lines = renderBalance(result)
        const rate = currentRate()
        if (rate !== undefined && result?.ok === true && result.primary.currency === 'CNY') {
          lines.push(`  (≈ $${(result.primary.total / rate).toFixed(4)} USD at ${rate.toFixed(4)})`)
        }
        return { kind: result?.ok === true ? 'success' : 'error', text: lines.join('\n') }
      },
    })
  }, 'cost-meter: command lifecycle')

  /** Register both browser-facing routes on an active webserver context. */
  const registerWebCarrier = (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: PRICING_ROUTE,
          handler: async (req, res) => {
            try {
              const { readFile } = await import('node:fs/promises')
              const source = await readFile(PRICING_FILE_URL, 'utf8')
              res.statusCode = 200
              // Served as .js on purpose: the browser resolves a module by content
              // type, and the source is plain ESM either way.
              res.setHeader('content-type', 'application/javascript; charset=utf-8')
              res.setHeader('cache-control', 'no-store')
              res.end(source)
            } catch (error) {
              res.statusCode = 500
              res.setHeader('content-type', 'text/plain; charset=utf-8')
              res.end(`cost-meter: cannot read the pricing core: ${String(error?.message ?? error)}`)
            }
          },
        }),
      'cost-meter: pricing route',
    )

    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: BALANCE_ROUTE,
          handler: async (req, res) => {
            // A refresh button must never serve a cached answer for the balance;
            // the price table and the rate ride their own TTLs.
            const balance = await refreshBalance({ force: true })
            const rate = await refreshRate()
            const pricing = await refreshPricing()
            const body = JSON.stringify({
              balance:
                balance?.ok === true
                  ? {
                      ok: true,
                      isAvailable: balance.isAvailable,
                      primary: balance.primary,
                      entries: balance.entries,
                      fetchedAt: balance.fetchedAt,
                    }
                  : {
                      ok: false,
                      reason: balance?.reason ?? 'unknown',
                      message: balance?.message ?? 'no result',
                      fetchedAt: balance?.fetchedAt,
                    },
              rate:
                rate?.ok === true
                  ? {
                      ok: true,
                      rate: rate.rate,
                      publishedAt: rate.publishedAt,
                      fetchedAt: rate.fetchedAt,
                      stale: rate.stale === true,
                    }
                  : { ok: false, reason: rate?.reason ?? 'unknown', message: rate?.message ?? 'no result' },
              pricing: PRICING_REVISION,
              // Live peak rates for the browser to price with. Absent when the
              // official page could not be read; the served core then falls back
              // to its own embedded table.
              liveRates:
                pricing?.ok === true
                  ? { ok: true, rates: pricing.rates, models: pricing.models, fetchedAt: pricing.fetchedAt, stale: pricing.stale === true }
                  : { ok: false, reason: pricing?.reason ?? 'unknown', message: pricing?.message ?? 'no result' },
              generatedAt: Date.now(),
            })
            res.statusCode = 200
            res.setHeader('content-type', 'application/json; charset=utf-8')
            // Personal financial data: never let a shared cache retain it.
            res.setHeader('cache-control', 'no-store')
            res.end(body)
          },
        }),
      'cost-meter: balance route',
    )
  }

  /**
   * Attach the routes to whatever HTTP carrier this composition mounts.
   *
   * This mirrors `dsh-client-modules` exactly: probe with `ctx.get(name)`, which
   * is always safe, and only defer through `ctx.inject` when the service is not
   * up yet. `webServer` stays out of this plugin's hard `inject` list so the two
   * commands still register in a composition that mounts no HTTP carrier at all.
   */
  if (ctx.get('webServer') === undefined) ctx.inject(['webServer'], registerWebCarrier)
  else registerWebCarrier(ctx)

  // Everything the tests and the routes need, returned rather than attached to
  // the Cordis context: `ctx.set` is the service-INTERCEPT API and throws for a
  // name this fiber never provided, and nothing consumes a `costMeter` service
  // anyway. A returned surface is testable without faking service semantics.
  return {
    foldSessionCost,
    refreshBalance,
    refreshRate,
    refreshPricing,
    currentRates,
    state,
    config: settings,
    currentRate,
    renderCost: (folded) => renderCost(folded, currentRate(), state.pricing),
    pricing: { PRICING_REVISION, resolveRates, isPeak },
  }
}
