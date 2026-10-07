/**
 * Live price-table reader.
 *
 * The official pricing page is static HTML whose figures sit in plain text, so
 * the current rates can be read instead of relying on a copy that silently ages.
 *
 * The failure policy is the point of this module. A scrape that cannot be parsed
 * confidently yields NO table rather than a guessed one: a wrong price is worse
 * than a stale one, because a stale price is visible (it carries a read date)
 * while a wrong one is not. Callers therefore fall back to the embedded table
 * and surface its date.
 *
 * Only the PEAK* columns are taken. The page also prints OFF-PEAK figures, and
 * the pricing core derives off-peak as exactly half of peak — reading the
 * off-peak column as well would create a second, independently-parsed source for
 * a relationship the core already guarantees, which is a way to get it wrong.
 *
 * @module dsh-cost-meter/live-pricing
 */

/** Official pricing page. */
export const PRICING_URL = 'https://api-docs.deepseek.com/quick_start/pricing'

/** A scrape older than this is discarded; the page changes on the order of months. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

const REQUEST_TIMEOUT_MS = 20_000

/** Bucket name fragment to bucket key. */
const BUCKET_BY_LABEL = [
  { label: 'CACHE HIT', bucket: 'cacheHitInput' },
  { label: 'CACHE MISS', bucket: 'cacheMissInput' },
  { label: 'OUTPUT TOKENS', bucket: 'output' },
]

/** One price cell: `$0.15`. */
const MONEY_CELL = /^\$(\d+(?:\.\d+)?)$/u

/**
 * Split the page into table rows of plain cell texts.
 *
 * Parsing is done per ROW, not over one flat token stream, because the two
 * layouts differ: the first pricing row carries the bucket label and the
 * `OFF-PEAK` label in the SAME first cell, while the later buckets put the label
 * in a cell of its own. Row cells make both shapes one lookup.
 *
 * @param html - the pricing page's HTML.
 * @returns rows, each an array of trimmed cell texts.
 */
function tableRows(html) {
  return html
    .split(/<tr[^>]*>/iu)
    .slice(1)
    .map((row) =>
      [...row.matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/giu)].map((match) =>
        match[1]
          .replace(/<[^>]+>/gu, ' ')
          .replace(/&nbsp;/giu, ' ')
          .replace(/\s+/gu, ' ')
          .trim(),
      ),
    )
    .filter((cells) => cells.length > 0)
}

/**
 * Read the model columns from the header row.
 *
 * A cell reads `deepseek-flash (1)`; the footnote marker is stripped. A
 * `BASE URL …` cell is skipped, so the row's trailing detail cells do not become
 * models — and so a rejected cell cannot shift every later column.
 *
 * @param rows - parsed table rows.
 * @returns model ids in column order.
 */
function parseModels(rows) {
  const header = rows.find((cells) => cells[0] === 'MODEL')
  if (header === undefined) return []
  return header
    .slice(1)
    .filter((cell) => !/^BASE URL/iu.test(cell))
    .map((cell) => cell.replace(/\s*\(\d+\)\s*$/u, '').trim())
    .filter((cell) => /^[a-z0-9][a-z0-9._-]*$/u.test(cell))
}

/**
 * Bucket for one row, or undefined when the row is not a pricing row.
 *
 * @param cells - the row's cells.
 * @returns the bucket key this row prices.
 */
function bucketOfRow(cells) {
  for (const cell of cells) {
    for (const { label, bucket } of BUCKET_BY_LABEL) {
      if (cell.includes(label)) return bucket
    }
  }
  return undefined
}

/**
 * Read the live rate table.
 *
 * Walking the rows in order and pairing each `PEAK` row with the pricing row
 * above it means a row whose shape is not understood simply contributes nothing
 * and the final completeness check rejects the whole table — the failure is a
 * refusal, never a shifted column.
 *
 * @param html - the pricing page's HTML.
 * @returns `{ models, rates, offPeak }` where `rates` is peak USD per 1M tokens
 *   keyed by model and bucket, or undefined when the page could not be parsed
 *   into a complete table. An incomplete table is never returned partially.
 */
export function parsePricingPage(html) {
  const rows = tableRows(html)
  const models = parseModels(rows)
  if (models.length === 0) return undefined

  const rates = {}
  const offPeak = {}
  for (const model of models) {
    rates[model] = {}
    offPeak[model] = {}
  }

  /** Bucket whose OFF-PEAK row is waiting for its PEAK row. */
  let pendingBucket

  for (const cells of rows) {
    const isPeakRow = cells.includes('PEAK')
    const bucket = bucketOfRow(cells)
    const money = cells.map((cell) => {
      const match = MONEY_CELL.exec(cell)
      return match === null ? undefined : Number.parseFloat(match[1])
    }).filter((value) => value !== undefined)

    if (isPeakRow) {
      // A PEAK row must close a pending bucket and carry one price per model.
      if (pendingBucket === undefined || money.length !== models.length) return undefined
      models.forEach((model, i) => {
        rates[model][pendingBucket] = money[i]
      })
      pendingBucket = undefined
      continue
    }

    if (bucket === undefined) continue

    // A pricing row carrying OFF-PEAK is an off-peak half of a pair; one without
    // it is a layout this parser does not understand and must not guess at.
    if (!cells.includes('OFF-PEAK')) return undefined
    if (money.length !== models.length) return undefined
    // Two off-peak rows for one bucket cannot both be closed.
    if (pendingBucket !== undefined) return undefined
    models.forEach((model, i) => {
      offPeak[model][bucket] = money[i]
    })
    pendingBucket = bucket
  }

  // No pair may be left open.
  if (pendingBucket !== undefined) return undefined

  // Every model must carry all three buckets, in both series, or the table is
  // partial — and a partial table is refused rather than partly applied.
  for (const model of models) {
    for (const { bucket } of BUCKET_BY_LABEL) {
      if (!Number.isFinite(rates[model][bucket])) return undefined
      if (!Number.isFinite(offPeak[model][bucket])) return undefined
    }
  }

  return { models, rates, offPeak }
}


/**
 * Read the live table, reusing a cache inside its TTL.
 *
 * @param cache - mutable single-slot cache owned by the caller.
 * @param signal - optional cancellation signal.
 * @returns the table readout, or a failure descriptor. A stale cached table is
 *   preferred over no table, and is always flagged.
 */
export async function readLivePricing(cache, signal) {
  const now = Date.now()
  if (cache.value !== undefined && now - cache.value.fetchedAt < CACHE_TTL_MS) {
    return { ok: true, ...cache.value, cached: true }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  if (signal !== undefined) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  try {
    const response = await fetch(PRICING_URL, {
      method: 'GET',
      headers: { accept: 'text/html' },
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!response.ok) {
      return staleOr(cache, { ok: false, reason: 'http', status: response.status, message: `pricing page answered HTTP ${response.status}` })
    }
    const html = await response.text()
    const parsed = parsePricingPage(html)
    if (parsed === undefined) {
      return staleOr(cache, {
        ok: false,
        reason: 'unparseable',
        message: 'the pricing page did not yield a complete table; keeping the embedded rates rather than guessing',
      })
    }
    const value = { ...parsed, fetchedAt: Date.now(), source: PRICING_URL }
    cache.value = value
    return { ok: true, ...value, cached: false }
  } catch (error) {
    clearTimeout(timer)
    return staleOr(cache, {
      ok: false,
      reason: controller.signal.aborted ? 'timeout' : 'network',
      message: String(error?.message ?? error),
    })
  }
}

/** Fall back to the last good table, flagged stale, rather than losing live rates. */
function staleOr(cache, failure) {
  if (cache.value !== undefined) return { ok: true, ...cache.value, cached: true, stale: true, failure }
  return failure
}
