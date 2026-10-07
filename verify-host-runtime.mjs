/**
 * Runtime verification for the host half.
 *
 * `--dump-config` proves the row composes; it cannot prove `apply()` runs, that
 * the services it injects exist, that both commands register, or that the
 * balance route answers. This executes the real `apply()` against stub Cordis
 * services and then drives both HTTP routes with mock req/res objects.
 *
 * Run with: node verify-host-runtime.mjs
 *
 * The balance route is exercised twice: once with no credential (the expected
 * degraded answer) and, when DEEPSEEK_API_KEY is present in the environment, once
 * against the real endpoint.
 */
import { readFileSync } from 'node:fs'

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

const { apply, inject, name } = await import('./lib/index.js')

// --- the plugin's declared shape -------------------------------------------
console.log('--- plugin surface ---')
check('name', name, 'cost-meter')
check('injects commands', inject.includes('commands'), true)

/**

 * Stub Cordis context.
 *
 * `effect` runs a generator body to completion, which is what a real Cordis
 * fiber does for a generator plugin body: every yielded disposer is collected
 * and the body's own registration calls therefore actually happen.
 */
function makeCtx({ withWebServer = true, credentials } = {}) {
  const commands = []
  const routes = []
  const effects = []
  const injected = []

  const ctx = {
    credentials,
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {}
      },
    },
    webServer: withWebServer
      ? {
          register(route) {
            routes.push(route)
            return () => {}
          },
        }
      : undefined,
    effect(body) {
      effects.push(body)
      if (typeof body === 'function') {
        const iterator = body()
        if (iterator !== undefined && typeof iterator.next === 'function') {
          let step = iterator.next()
          while (step.done !== true) {
            // A yielded disposer is simply collected; nothing to dispose in a test.
            step = iterator.next()
          }
        }
      }
      return () => {}
    },
    get(serviceName) {
      return serviceName === 'webServer' ? ctx.webServer : undefined
    },
    // The documented inject-free service read. Mimicking the real name matters:
    // the first draft of this plugin called `ctx.get(...)`, which does not exist
    // on Cordis, and a harness that had accepted either spelling would have
    // hidden the very bug that broke the real plugin tree at startup.
    reflect: {
      get(serviceName) {
        if (serviceName === 'webServer') return ctx.webServer
        if (serviceName === 'credentials') return ctx.credentials
        return undefined
      },
    },
    // The real context carries `inject(deps, cb)`, which runs the callback once
    // the requested services are active and otherwise HOLDS it pending. The
    // stub records the pending request instead of calling back, which is what
    // lets a test distinguish "deferred forever" from "ran with a missing
    // service" 鈥?a stub that always called back would hide the very bug this
    // suite exists to catch.
    inject(deps, callback) {
      injected.push(deps)
      const missing = deps.filter((name) => ctx.reflect.get(name) === undefined)
      if (missing.length === 0) callback(ctx)
      return { then: () => {} }
    },
    set() {},
  }

  return { ctx, commands, routes, effects, injected }
}

// --- apply() runs and registers everything ---------------------------------
console.log('--- apply() with a webserver ---')
const primary = makeCtx()
let applyThrew
try {
  apply(primary.ctx, { apiKeyEnv: 'DEEPSEEK_API_KEY', balanceBaseURL: 'https://api.deepseek.com' })
} catch (error) {
  applyThrew = error
}
check('apply() does not throw', applyThrew, undefined)
check('two commands registered', primary.commands.length, 2)
const names = primary.commands.map((c) => c.name).sort()
check('commands are cost and balance', names.join(','), 'balance,cost')
check('every command has a handler', primary.commands.every((c) => typeof c.handler === 'function'), true)
check('every command has a description', primary.commands.every((c) => typeof c.description === 'string' && c.description.length > 0), true)
check('two routes registered', primary.routes.length, 2)
const paths = primary.routes.map((r) => r.path).sort()
check('routes are pricing and balance', paths.join(','), '/cost-meter/balance,/cost-meter/pricing.js')
check('routes use exact match', primary.routes.every((r) => r.kind === 'exact'), true)

// --- apply() tolerates a composition with no HTTP carrier -------------------
console.log('--- apply() without a webserver ---')
const headless = makeCtx({ withWebServer: false })
let headlessThrew
try {
  apply(headless.ctx, undefined)
} catch (error) {
  headlessThrew = error
}
check('apply() survives a missing webserver', headlessThrew, undefined)
check('commands still registered', headless.commands.length, 2)
check('no routes attempted', headless.routes.length, 0)

// --- the pricing route serves the shared core verbatim ----------------------
console.log('--- pricing route ---')
const pricingRoute = primary.routes.find((r) => r.path === '/cost-meter/pricing.js')
const pricingRes = makeRes()
await pricingRoute.handler({ url: '/cost-meter/pricing.js' }, pricingRes)
check('pricing route answers 200', pricingRes.statusCode, 200)
checkTruthy('pricing route sets a javascript content type', String(pricingRes.headers['content-type']).includes('javascript'))
const localCore = readFileSync(new URL('./lib/pricing-core.mjs', import.meta.url), 'utf8')
check('served bytes are the local core, unmodified', pricingRes.body === localCore, true)
checkTruthy('served core exports costOfTotals', pricingRes.body.includes('export function costOfTotals'))

// --- the balance route answers structured JSON in both credential states ----
// The reference name is deliberately NOT the one this test process exports, so
// the unconfigured branch is exercised honestly rather than silently reading the
// real key out of the ambient environment.
console.log('--- balance route, unconfigured credential reference ---')
const noCred = makeCtx()
apply(noCred.ctx, { apiKeyEnv: 'COST_METER_TEST_ABSENT_KEY' })
const noCredRoute = noCred.routes.find((r) => r.path === '/cost-meter/balance')
const noCredRes = makeRes()
await noCredRoute.handler({ url: '/cost-meter/balance' }, noCredRes)
check('balance route answers 200 even when unconfigured', noCredRes.statusCode, 200)
const noCredBody = JSON.parse(noCredRes.body)
check('reports an unusable balance', noCredBody.balance.ok, false)
check('names the missing credential', noCredBody.balance.reason, 'credential-missing')
checkTruthy('the message names the missing reference', noCredBody.balance.message.includes('COST_METER_TEST_ABSENT_KEY'))
checkTruthy('the response does not leak a key field', !('apiKey' in noCredBody.balance && noCredBody.balance.apiKey !== undefined))
check('sets cache-control no-store', noCredRes.headers['cache-control'], 'no-store')

// A credentials service that fails must degrade the same way, never throw.
console.log('--- balance route, credentials service failing ---')
const failing = makeCtx({
  credentials: {
    async resolve() {
      throw new Error('credential store unavailable')
    },
  },
})
apply(failing.ctx, { apiKeyEnv: 'DEEPSEEK_API_KEY' })
const failingRoute = failing.routes.find((r) => r.path === '/cost-meter/balance')
const failingRes = makeRes()
await failingRoute.handler({ url: '/cost-meter/balance' }, failingRes)
check('a throwing credential store still answers 200', failingRes.statusCode, 200)
check('and is reported as a credential error', JSON.parse(failingRes.body).balance.reason, 'credential-error')

// When a key is available in this process, drive the real endpoint too.
if (typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY.length > 0) {
  console.log('--- balance route, real endpoint ---')
  const live = makeCtx()
  apply(live.ctx, undefined)
  const liveRoute = live.routes.find((r) => r.path === '/cost-meter/balance')
  const liveRes = makeRes()
  await liveRoute.handler({ url: '/cost-meter/balance' }, liveRes)
  const liveBody = JSON.parse(liveRes.body)
  check('live balance read succeeded', liveBody.balance.ok, true)
  checkTruthy('live balance carries a primary entry', liveBody.balance.primary !== undefined)
  checkTruthy('live balance amount is a finite number', Number.isFinite(liveBody.balance.primary.total))
  check('account currency is CNY', liveBody.balance.primary.currency, 'CNY')
  checkTruthy('the key is absent from the payload', !liveRes.body.includes(process.env.DEEPSEEK_API_KEY))
  checkTruthy('the payload carries a live-price readout', liveBody.liveRates !== undefined)
  if (liveBody.liveRates.ok === true) {
    checkTruthy('live prices carry a rate per model', typeof liveBody.liveRates.rates === 'object')
    console.log(`      live prices: ${liveBody.liveRates.models.join(', ')}`)
  } else {
    console.log(`      live prices unavailable (${liveBody.liveRates.reason}) 鈥?the served core falls back to its embedded table`)
  }
  if (liveBody.rate.ok === true) {
    checkTruthy('live rate is a finite positive number', Number.isFinite(liveBody.rate.rate) && liveBody.rate.rate > 0)
    console.log(`      balance ${liveBody.balance.primary.total} ${liveBody.balance.primary.currency}, rate ${liveBody.rate.rate}`)
  } else {
    console.log(`      rate unavailable (${liveBody.rate.reason}) 鈥?conversion degrades, cost still available`)
  }
} else {
  console.log('--- balance route, real endpoint: SKIPPED (no DEEPSEEK_API_KEY in this process) ---')
}

// --- the /cost command prices a synthetic session --------------------------
console.log('--- /cost command handler ---')
const costCommand = primary.commands.find((c) => c.name === 'cost')
const syntheticEvents = [
  { type: 'request/header', time: Date.UTC(2026, 8, 16, 5), data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } },
  { type: 'assistant/message', time: Date.UTC(2026, 8, 16, 5), data: { usage: { inputTokens: 1_000_000, outputTokens: 0 } } },
]
const costResult = await costCommand.handler({
  agent: { session: { snapshotEvents: () => syntheticEvents } },
  signal: undefined,
})
check('cost handler reports success', costResult.kind, 'success')
checkTruthy('cost text names the session cost', costResult.text.includes('Session cost'))
checkTruthy('cost text states where the prices came from', costResult.text.includes('Prices:'))

console.log('--- /cost with an unreadable session ---')
const emptyResult = await costCommand.handler({ agent: { session: { snapshotEvents: () => [] } }, signal: undefined })
check('an empty session is an error, not a silent zero', emptyResult.kind, 'error')

/** One mock ServerResponse collecting status, headers, and body. */
function makeRes() {
  const headers = {}
  return {
    statusCode: undefined,
    headers,
    body: '',
    setHeader(key, value) {
      headers[String(key).toLowerCase()] = value
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
    },
  }
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
