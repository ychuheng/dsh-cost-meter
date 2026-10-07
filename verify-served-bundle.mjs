/**
 * Verify the bundle the LIVE server actually serves carries the new typography.
 *
 * Reading the local source would only prove the edit landed on disk. This reads
 * the bytes the Host hands the browser, which is what decides what the reader
 * sees. Source maps are irrelevant here; the assertions are on served text.
 *
 * Usage: node verify-served-bundle.mjs <bundle-url>
 */
const url = process.argv[2]
if (url === undefined) {
  console.log('usage: node verify-served-bundle.mjs <bundle-url>')
  process.exit(2)
}

const response = await fetch(url)
const src = await response.text()

let failures = 0
function check(label, actual, expected) {
  const ok = Object.is(actual, expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`      expected ${expected}, got ${actual}`)
}

console.log(`served ${src.length} bytes (HTTP ${response.status})`)
check('HTTP status', response.status, 200)

// Target 1 and 2: the type size must be the two tokens the shipped stats pill
// uses, named explicitly rather than inherited.
check(
  'served bundle names the shared font-size token',
  src.includes('var(--dsh-content-font-size-secondary, 13px)'),
  true,
)
check(
  'served bundle names the shared line-height token',
  src.includes('var(--dsh-content-font-delta-secondary, 0px)'),
  true,
)
check('served bundle does NOT use fontSize: inherit', src.includes("fontSize: 'inherit'"), false)
check('served bundle does NOT use lineHeight: inherit', src.includes("lineHeight: 'inherit'"), false)

// Target 3: the divider matches the shipped separator treatment.
check('served bundle uses the shared separator colour', src.includes('var(--dsw-alias-separator-primary'), true)
check('served bundle uses the shared separator margins', src.includes("margin: '0 6px'"), true)

// Target 4: the readout SHARES the strip. The dock is a `nowrap` row
// (`.RlGAzG_dock{display:flex;flex-direction:row;flex-wrap:nowrap;
// justify-content:center;gap:12px;max-width:100%}`), and line breaking is a
// property of the CONTAINER — no occupant style can produce a second line. A DOM
// probe confirmed it after two wrong attempts: `width:100%` only filled the
// existing line, and `flex-basis:100%` widened the dock to `stats + a full
// basis` (619px) instead of wrapping. The settled shape is a shrink-wrapped
// pill, so a reintroduced wrap attempt is the regression asserted against here.
check('served bundle shrink-wraps the readout', src.includes("display: 'inline-flex'"), true)
check('served bundle does NOT claim a full flex basis', src.includes("flexBasis: '100%'"), false)
check('served bundle does NOT claim a full width', src.includes("width: '100%'"), false)
check('served bundle uses the packaged 999px pill radius', src.includes("borderRadius: '999px'"), true)
check(
  'served bundle mirrors the packaged one-pixel-smaller font size',
  src.includes('calc(var(--dsh-content-font-size-secondary, 13px) - 1px)'),
  true,
)

// Target 5: the readout still lives in the composer dock.
check('served bundle targets the composer dock', src.includes("'conversation.composer.dock'"), true)
check('served bundle does NOT target the old header slot', src.includes('conversation.session.header.utilities'), false)

// And it must still be loadable as a lazy-CJS factory.
let registered
const window = { __ModuleLoader__: { load: (entry) => (registered = entry) } }
new Function('window', 'document', src)(window, {})
check('bundle registers one factory', registered !== undefined && registered.id === 'dsh-cost-meter', true)

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
