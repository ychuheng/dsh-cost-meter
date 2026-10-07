/**
 * Network-backed reads for dsh-cost-meter: the DeepSeek account balance and the
 * USD/CNY rate.
 *
 * Both are Host-side reads that touch the network, so they are isolated from the
 * local cost accounting: a failure here degrades the balance or the converted
 * figure, and must never take the cost readout down with it.
 *
 * The API key is resolved per operation through `ctx.credentials` and never
 * leaves this module: no return value, log line, or error message carries it.
 */

/** Default credential reference; configuration names the ref, never the value. */
export const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** Public API default. Deliberately independent of $DEEPSEEK_BASE_URL, which may be an internal gateway. */
export const DEFAULT_BALANCE_BASE_URL = 'https://api.deepseek.com'

/** Keyless USD rate source. Answers roughly once a day, so a short TTL is already fresh enough. */
const FOREX_URL = 'https://open.er-api.com/v6/latest/USD'

/** How long a fetched rate is reused. */
const FOREX_TTL_MS = 60 * 60 * 1000

/** Bound on any single outbound read so a hung endpoint cannot stall a refresh. */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * Resolve the API key for one operation.
 *
 * The credentials service is authoritative when mounted; without it the launching
 * process environment is the fallback. Resolution happens per call, so a rotated
 * key reaches the very next request without a restart.
 *
 * @param ctx - host context, optionally carrying a credentials service.
 * @param refName - credential reference name.
 * @returns the key value, or undefined when unconfigured.
 */
async function resolveApiKey(ctx, refName) {
  // `ctx.credentials` would throw unless `credentials` were declared in `inject`,
  // and this plugin must load in compositions that mount no credential store.
  // `ctx.reflect.get` is the read that carries no inject requirement.
  const credentials = ctx.reflect?.get('credentials')
  if (credentials !== undefined && credentials !== null) {
    const hit = await credentials.resolve(refName)
    if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) {
      return hit.value
    }
  }
  const ambient = process.env[refName]
  if (typeof ambient === 'string' && ambient.length > 0) return ambient
  return undefined
}

/** Normalize a base URL by dropping trailing slashes. */
function normalizeBase(baseURL) {
  return String(baseURL).replace(/\/+$/u, '')
}

/**
 * Convert a provider money field to a number.
 *
 * The balance endpoint returns these as STRINGS, so they must never be used
 * arithmetically before conversion.
 *
 * @param value - raw field from the response.
 * @returns the parsed amount, or undefined when unparseable.
 */
function parseAmount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Read the account balance.
 *
 * @param ctx - host context for credential resolution.
 * @param options - endpoint base, credential reference, cancellation signal.
 * @returns the balance readout, or a failure descriptor. Never throws for an
 *   expected transport or credential problem, so a caller can render a degraded
 *   state instead of an exception.
 */
export async function readBalance(ctx, options = {}) {
  const baseURL = normalizeBase(options.baseURL ?? DEFAULT_BALANCE_BASE_URL)
  const refName = options.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  const fetchedAt = Date.now()

  let apiKey
  try {
    apiKey = await resolveApiKey(ctx, refName)
  } catch (error) {
    return { ok: false, reason: 'credential-error', message: String(error?.message ?? error), fetchedAt }
  }
  if (apiKey === undefined) {
    return {
      ok: false,
      reason: 'credential-missing',
      message: `no value for credential "${refName}"; store it in Settings > Models, export it in the launching environment, or set a literal value in the plugin config`,
      fetchedAt,
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  let response
  try {
    response = await fetch(`${baseURL}/user/balance`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    return {
      ok: false,
      reason: controller.signal.aborted ? 'timeout' : 'network',
      message: controller.signal.aborted ? `no answer within ${REQUEST_TIMEOUT_MS} ms` : String(error?.message ?? error),
      fetchedAt,
    }
  }
  clearTimeout(timer)

  if (!response.ok) {
    return {
      ok: false,
      reason: response.status === 401 || response.status === 403 ? 'unauthorized' : 'http',
      status: response.status,
      message:
        response.status === 401 || response.status === 403
          ? `the endpoint rejected the key for "${refName}" (HTTP ${response.status})`
          : `balance endpoint answered HTTP ${response.status}`,
      fetchedAt,
    }
  }

  let body
  try {
    body = await response.json()
  } catch (error) {
    return { ok: false, reason: 'malformed', message: `balance response was not JSON: ${String(error?.message ?? error)}`, fetchedAt }
  }

  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : []
  const entries = infos
    .map((info) => ({
      currency: typeof info?.currency === 'string' ? info.currency : undefined,
      total: parseAmount(info?.total_balance),
      granted: parseAmount(info?.granted_balance),
      toppedUp: parseAmount(info?.topped_up_balance),
    }))
    .filter((entry) => entry.currency !== undefined)

  if (entries.length === 0) {
    return { ok: false, reason: 'malformed', message: 'balance response carried no balance_infos entry', fetchedAt }
  }

  // Prefer the account's CNY entry when present; the account currency decides,
  // not a configuration preference.
  const primary = entries.find((entry) => entry.currency === 'CNY') ?? entries[0]

  return {
    ok: true,
    isAvailable: body?.is_available === true,
    primary,
    entries,
    fetchedAt,
  }
}

/**
 * Read the USD/CNY rate, reusing a cached value inside its TTL.
 *
 * @param cache - mutable single-slot cache owned by the caller.
 * @param signal - optional cancellation signal.
 * @returns the rate readout, or a failure descriptor.
 */
export async function readUsdCnyRate(cache, signal) {
  const now = Date.now()
  if (cache.value !== undefined && now - cache.value.fetchedAt < FOREX_TTL_MS) {
    return { ok: true, ...cache.value, cached: true }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  if (signal !== undefined) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  try {
    const response = await fetch(FOREX_URL, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal })
    clearTimeout(timer)
    if (!response.ok) {
      return staleOr(cache, { ok: false, reason: 'http', status: response.status, message: `rate endpoint answered HTTP ${response.status}` })
    }
    const body = await response.json()
    if (body?.result !== 'success') {
      return staleOr(cache, { ok: false, reason: 'malformed', message: `rate endpoint reported result=${String(body?.result)}` })
    }
    const rate = body?.rates?.CNY
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      return staleOr(cache, { ok: false, reason: 'malformed', message: 'rate response carried no usable rates.CNY' })
    }
    const value = {
      rate,
      fetchedAt: Date.now(),
      publishedAt: typeof body?.time_last_update_utc === 'string' ? body.time_last_update_utc : undefined,
      source: 'open.er-api.com',
    }
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

/** Fall back to the last good rate, flagged stale, rather than losing the conversion entirely. */
function staleOr(cache, failure) {
  if (cache.value !== undefined) return { ok: true, ...cache.value, cached: true, stale: true, failure }
  return failure
}
