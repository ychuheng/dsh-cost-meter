/**
 * Verification for the browser half.
 *
 * Run with: node verify-client.mjs
 *
 * The bundle is hand-written lazy-CJS, so nothing type-checks it. This executes
 * it against a stub loader and a stub React to catch the failure modes that
 * would otherwise only appear as a blank header in a live browser: a syntax
 * error, a wrong registration name, a missing export, or a factory that throws
 * while building its element tree.
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

const source = readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8')

// --- the bundle registers exactly one factory under its package name ---------
const registrations = []
const window = {
  __ModuleLoader__: {
    load(entry) {
      registrations.push(entry)
    },
  },
}

// Give the bundle the two globals a browser would provide.
const run = new Function('window', 'document', source)
run(window, { createElement: () => ({}) })

check('exactly one factory registered', registrations.length, 1)
const entry = registrations[0]
check('factory id is the package name', entry.id, 'dsh-cost-meter')
check('factory is a function', typeof entry.factory, 'function')

// --- the factory requires only React, and only that --------------------------
const requested = []

/**
 * Stateful React stub.
 *
 * `renders` is a cursor list: each render pass consumes the next value for each
 * `useState` slot, so re-invoking the component simulates a re-render with
 * whatever an effect would have set. `setters` collects the setter callbacks so
 * a test can drive the next pass. A stateless stub could never observe the
 * component's populated branch — which is exactly the branch that renders the
 * money, so a stateless stub would verify nothing that matters.
 */
let renderPass = 0
const renders = []
const setters = []
/** Per-pass slot cursor. Seeded values must not advance it, or a pre-filled
 *  pass would read past its own slots and silently fall back to `initial`. */
const cursors = []

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState(initial) {
    const pass = renderPass
    if (renders[pass] === undefined) renders[pass] = []
    if (cursors[pass] === undefined) cursors[pass] = 0
    const slot = cursors[pass]
    cursors[pass] = slot + 1
    const value = slot < renders[pass].length ? renders[pass][slot] : typeof initial === 'function' ? initial() : initial
    renders[pass][slot] = value
    const setter = (next) => {
      setters.push({ slot, next })
    }
    return [value, setter]
  },
  useEffect: () => {},
  useCallback: (fn) => fn,
  // The component holds a DOM ref for its one-shot layout probe. The stub
  // returns a fresh object so a render never crashes on a null ref.
  useRef: (initial) => ({ current: initial === undefined ? null : initial }),
}

const requireStub = (spec) => {
  requested.push(spec)
  if (spec === 'react') return reactStub
  throw new Error(`unexpected require("${spec}") — the bundle must stay dependency-free`)
}

const exports = entry.factory(requireStub)

check('factory requires only react', requested.join(','), 'react')
check('exports apply', typeof exports.apply, 'function')
check('exports inject', Array.isArray(exports.inject), true)
check('injects the slots service', exports.inject.includes('slots'), true)

// --- apply registers into the composer dock ---------------------------------
const injections = []
const registrationsMade = []
const ctx = {
  slots: {
    inject(name, fn) {
      injections.push(name)
      return fn()
    },
    register(target, component) {
      registrationsMade.push({ target, component })
      return () => {}
    },
  },
}

exports.apply(ctx)

check('injects into one slot', injections.length, 1)
check('slot is the composer dock', injections[0], 'conversation.composer.dock')
check('registers one occupant', registrationsMade.length, 1)
check('occupant names the same slot', registrationsMade[0].target.name, 'conversation.composer.dock')
// The dock is a list slot whose shipped occupant (StatsPills) registers under
// id 'stats' at order 0. A DIFFERENT id adds a sibling cell instead of replacing
// that one, and a higher order places it to the right — which is the whole point
// of the change, so both are pinned.
check('occupant uses its OWN id so it adds rather than replaces', registrationsMade[0].target.id, 'cost-meter')
check('occupant does not reuse the shipped stats id', registrationsMade[0].target.id !== 'stats', true)
check('occupant orders after the stats pill (order 0)', registrationsMade[0].target.order > 0, true)
check('occupant is a component function', typeof registrationsMade[0].component, 'function')

// --- the component renders without a DOM in every data state ----------------
const CostMeterAction = registrationsMade[0].component

/** One projection reader standing in for the render kit. */
function makeUseProjection(values) {
  return (key) => values[key]
}

const cases = [
  {
    label: 'no usage and no remote answer yet',
    projection: {},
    expectNull: true,
  },
  {
    label: 'balance present',
    projection: {},
    expectNull: false,
  },
]

// The first two cases differ only by the remote state, which this harness cannot
// inject; assert the projection-driven path instead, which is the one that can
// silently regress.
const nullRender = CostMeterAction({
  sessionId: 's',
  useProjection: makeUseProjection({}),
})
check('renders nothing before any Host answer', nullRender, null)

// A component that throws while building its tree is the worst failure mode
// because it takes the whole header down; assert it survives the real wire shape
// of `tokenUsage`, which is one FLAT object of four buckets — not a `{ totals }`
// wrapper. Getting this shape wrong would silently render no cost at all.
let rendered
try {
  rendered = CostMeterAction({
    sessionId: 's',
    useProjection: makeUseProjection({
      tokenUsage: {
        uncachedInputTokens: 111543,
        outputTokens: 53460,
        cacheReadTokens: 9008256,
        cacheWriteTokens: 0,
      },
      modelSelection: { lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    }),
  })
} catch (error) {
  failures += 1
  console.log(`FAIL  component threw with a populated projection: ${error.message}`)
}
checkTruthy('component survives a populated projection', rendered === null || rendered !== undefined)

// --- the money actually appears in the rendered output ---------------------
//
// This is the assertion that matters most: a component can render without
// throwing and still show no cost, which is precisely the silent failure the
// acceptance criterion "cost updates after each reply" would otherwise miss.
//
// The runtime supplies these two slots via `dsh-client-ui-session`'s
// `keyedHooks: { projection }`; the props below mirror the real kit.
console.log('--- the readout carries the balance AND the cost ---')

/** Build a component invocation with a chosen state cursor. */
function renderWith({ projectionValues, state }) {
  renderPass = state.pass
  renders[state.pass] = state.slots.slice()
  cursors[state.pass] = 0
  return CostMeterAction({
    sessionId: 'session-x',
    // The real kit's prop name for the keyed projection hook.
    useProjection: makeUseProjection(projectionValues),
    t: (key, vars) => key,
  })
}

/** Flatten the element tree into one text blob for substring assertions. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.children)
}

/**
 * Every element reachable in the tree, flattened.
 *
 * `createElement(type, props, childrenArray)` nests one level (React splits a
 * single array argument too), so a shallow scan of `.children` misses real
 * descendants. Walking the whole tree is what makes a structural assertion like
 * "the divider uses the shipped separator token" meaningful.
 */
function elementsOf(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  out.push(node)
  elementsOf(node.children, out)
  return out
}

/** The fake pricing core, shaped exactly like the served module's exports. */
const fakePricing = {
  PRICING_REVISION: { source: 'test', readOn: '2026-09-18' },
  costOfTotals: (totals, model, epochMs, overrides) => {
    if (model !== 'deepseek-flash') return undefined
    const rates = overrides?.['deepseek-flash'] ?? { cacheHitInput: 0.006, cacheMissInput: 0.3, output: 1.2 }
    const hit = totals.cacheReadTokens ?? 0
    const miss = totals.uncachedInputTokens ?? 0
    const out = totals.outputTokens ?? 0
    // A fixed off-peak (factor 0.5) result so the expected string is exact.
    const usd = ((hit * rates.cacheHitInput + miss * rates.cacheMissInput + out * rates.output) * 0.5) / 1e6
    return { usd, peak: false, model, tokens: { cacheHitInput: hit, cacheMissInput: miss, output: out, total: hit + miss + out } }
  },
  usdToCny: (usd, rate) => usd * rate,
  formatCny: (cny) => (cny === 0 ? '0.00' : Math.abs(cny) < 0.01 ? cny.toFixed(4) : cny.toFixed(2)),
}

const fullProjection = {
  tokenUsage: { uncachedInputTokens: 111543, outputTokens: 53460, cacheReadTokens: 9008256, cacheWriteTokens: 0 },
  modelSelection: { lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' } },
}

const happy = renderWith({
  projectionValues: fullProjection,
  state: {
    pass: 0,
    // Slot order as the component declares them:
    //   [pricing, remote, pending, opened, now]
    slots: [
      fakePricing,
      {
        balance: { ok: true, isAvailable: true, primary: { currency: 'CNY', total: 13.02, granted: 0, toppedUp: 13.02 }, entries: [], fetchedAt: 1789738015465 },
        rate: { ok: true, rate: 6.721845, fetchedAt: 1789737996269, stale: false },
        liveRates: { ok: true, rates: {}, models: ['deepseek-flash'], fetchedAt: 1789737996946, stale: false },
      },
      false,
      false,
      Date.UTC(2026, 8, 16, 5),
    ],
  },
})

const happyText = textOf(happy)
checkTruthy('the readout renders an element', happy !== null && happy !== undefined)
checkTruthy('it shows the balance in CNY', happyText.includes('¥13.02'))
checkTruthy('it shows the session cost', happyText.includes('本次 ¥'))
checkTruthy('and the cost is not the empty placeholder', !happyText.includes('本次 ?'))

// The type size must come from the same theme token the shipped stats pill
// uses for its token count. Pinning the token — not a pixel value — is what
// keeps the two in step when the reader changes their content font size.
console.log('--- the readout shares the composer strip ---')
const rootNode = happy
const rootStyle = rootNode.props?.style ?? {}

// Placement was decided by probing the live DOM. The dock is a `nowrap` row
// (`.RlGAzG_dock{display:flex;flex-direction:row;flex-wrap:nowrap;
// justify-content:center;gap:12px;max-width:100%}`), and line breaking is a
// property of the CONTAINER — no style on an occupant can produce a second line.
// Two earlier attempts proved it: `width:100%` only filled the existing line,
// and `flex-basis:100%` widened the dock to `stats + a full basis` (measured 619px)
// instead of wrapping. These assertions pin the settled behaviour so a future
// edit cannot quietly reintroduce a wrap attempt that cannot work.
check('the outer element shrink-wraps', rootStyle.display, 'inline-flex')
check('it does not claim a full flex basis', rootStyle.flexBasis, undefined)
check('it does not claim a full width', rootStyle.width, undefined)
check('it may shrink, never grow', rootStyle.flex, '0 1 auto')
check('it can never overflow the strip', rootStyle.maxWidth, '100%')
check('the pill radius matches the packaged stats pill', rootStyle.borderRadius, '999px')

console.log('--- type matches the shipped stats pill ---')
const all = elementsOf(rootNode)
// The packaged app's rule subtracts one pixel from the secondary token:
// `.iq1doa_root{font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px)}`
check(
  'font-size mirrors the packaged stats pill, one pixel under the token',
  rootStyle.fontSize,
  'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
)
check(
  'line-height carries the matching delta token',
  rootStyle.lineHeight,
  'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
)
check('the label colour matches the stats pill', rootStyle.color, 'var(--dsw-alias-label-tertiary, #888)')
checkTruthy('it is NOT font-size:inherit (which would break on a wrapper)', rootStyle.fontSize !== 'inherit')
checkTruthy('it is NOT line-height:inherit', rootStyle.lineHeight !== 'inherit')

const pillNode = all.find((el) => el.props?.style?.padding === '1px 8px')
checkTruthy('an inner pill exists', pillNode !== undefined)
check('the pill is an inline flex', pillNode?.props?.style?.display, 'inline-flex')

// The divider between segments must use the shipped separator token too, or the
// strip reads as two different components.
/** Whether an element's rendered children are exactly this text.
 *  A stub collects `createElement(type, props, child)` as `[child]`, so the text
 *  arrives wrapped in an array; accepting both shapes keeps the assertion about
 *  the separator, not about the stub. */
const hasText = (el, text) =>
  el.children === text || (Array.isArray(el.children) && el.children.length === 1 && el.children[0] === text)
const separators = all.filter((el) => el.type === 'span' && hasText(el, '·'))
check('segments are divided by separator spans', separators.length > 0, true)
if (separators.length > 0) {
  check(
    'the divider uses the shipped separator colour',
    separators[0].props?.style?.color,
    'var(--dsw-alias-separator-primary, #ccc)',
  )
  check('the divider carries the shipped 6px margins', separators[0].props?.style?.margin, '0 6px')
}
console.log(`      rendered: ${happyText.trim()}`)

// The unpriceable branch must be visibly distinct from a zero cost. A balance is
// supplied because the component deliberately hides itself entirely when it has
// neither a balance nor a price — showing "?" alone would be a control with
// nothing to act on.
const unpriced = renderWith({
  projectionValues: { ...fullProjection, modelSelection: { lastUsed: { model: 'some-unknown-model' } } },
  state: {
    pass: 0,
    slots: [
      fakePricing,
      { balance: { ok: true, isAvailable: true, primary: { currency: 'CNY', total: 13.02, granted: 0, toppedUp: 13.02 }, entries: [], fetchedAt: 1 }, rate: { ok: true, rate: 6.721845, fetchedAt: 1 }, liveRates: { ok: true, rates: {}, models: [], fetchedAt: 1 } },
      false,
      false,
      Date.UTC(2026, 8, 16, 5),
    ],
  },
})
const unpricedText = textOf(unpriced)
checkTruthy('an unpriceable model shows "?" rather than a number', unpricedText.includes('本次 ?'))
checkTruthy('and never shows a zero amount for it', !unpricedText.includes('本次 ¥0.00'))
console.log(`      rendered: ${unpricedText.trim()}`)

// A failed balance read must still render, so an outage is visible. With the
// rate down as well the cost correctly falls back to USD, so the assertion is
// on the cost being PRESENT, not on its currency — pinning the currency here
// would have encoded "the rate survived" into a test about the balance.
const failedBalance = renderWith({
  projectionValues: fullProjection,
  state: {
    pass: 0,
    slots: [
      fakePricing,
      { balance: { ok: false, reason: 'network', message: 'offline' }, rate: { ok: false, reason: 'network', message: 'offline' }, liveRates: { ok: false, reason: 'network' } },
      false,
      false,
      Date.UTC(2026, 8, 16, 5),
    ],
  },
})
const failedText = textOf(failedBalance)
checkTruthy('a failed balance read still renders', failedBalance !== null)
checkTruthy('and says the balance is unavailable', failedText.includes('余额不可用'))
checkTruthy('while the cost is still shown', failedText.includes('本次 $') || failedText.includes('本次 ¥'))
console.log(`      rendered: ${failedText.trim()}`)

// A session with no usage at all renders nothing at all.
renderPass = 0
renders[0] = [fakePricing, null, false, false, Date.now()]
cursors[0] = 0
const bare = CostMeterAction({ sessionId: 's', useProjection: makeUseProjection({}), t: (k) => k })
check('a session with no data renders nothing', bare, null)

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
