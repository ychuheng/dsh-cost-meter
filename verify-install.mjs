/**
 * Verification for the installer's patch-file handling.
 *
 * Run with: node verify-install.mjs
 *
 * The assertion that matters most is preservation. An earlier revision of the
 * installer rebuilt the patch file from parsed entries, which silently DISCARDS
 * the entire file when it contains no parseable entry — exactly the shape a
 * profile has while it still holds the scaffold `[]`. A recipient's existing
 * settings must never be one parse away from deletion, so every case here checks
 * that prior content survives verbatim.
 */
import { appendEntry, hasOwnRow, PATCH_ROW } from './install.mjs'

let failures = 0

function check(label, actual, expected) {
  const ok = Object.is(actual, expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function checkTruthy(label, value) {
  const ok = Boolean(value)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}

const HEADER = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).`

console.log('--- a scaffold-only patch keeps its comments ---')
{
  const original = `${HEADER}\n[]\n`
  const next = appendEntry(original)
  checkTruthy('the comment header survives', next.includes('# Your patch layer for this dsh profile'))
  checkTruthy('the !!js advice comment survives', next.includes('`!!js` expressions allowed'))
  checkTruthy('the loader-patch explanation survives', next.includes('id-targeted config'))
  checkTruthy('the scaffold [] is gone', !/^\[\]\s*$/m.test(next))
  checkTruthy('our row is appended', next.includes('- insert:'))
  checkTruthy('our row names the package', next.includes('name: dsh-cost-meter'))
}

console.log('--- an existing user entry is preserved byte for byte ---')
{
  const userEntry = `- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard
    performanceUsage: detailed`
  const original = `${HEADER}\n${userEntry}\n`
  const next = appendEntry(original)
  checkTruthy('the user entry survives exactly', next.includes(userEntry))
  checkTruthy('its nested config survives', next.includes('performanceUsage: detailed'))
  checkTruthy('our row is appended after it', next.indexOf('- insert:') > next.indexOf('ui-chat'))
  checkTruthy('the header survives', next.includes('# Your patch layer'))
}

console.log('--- an empty file is handled ---')
{
  const next = appendEntry('')
  checkTruthy('our row is present', next.includes('name: dsh-cost-meter'))
  checkTruthy('output is not prefixed with a stray blank block', !next.startsWith('\n\n'))
}

console.log('--- a [] inside a value is NOT stripped ---')
{
  // Only a whole-line scaffold may be removed; a literal [] in a value must stay.
  const original = `${HEADER}\n- id: something\n  config:\n    stop: []\n`
  const next = appendEntry(original)
  checkTruthy('the value [] survives', next.includes('stop: []'))
  checkTruthy('and our row is added', next.includes('name: dsh-cost-meter'))
}

console.log('--- CRLF input does not corrupt the result ---')
{
  const original = `${HEADER}\r\n[]\r\n`
  const next = appendEntry(original)
  checkTruthy('our row is present', next.includes('name: dsh-cost-meter'))
  checkTruthy(
    'no CRLF survives mid-file (the appended row is LF)',
    !next.slice(next.indexOf('- insert:')).includes('\r\n'),
  )
}

console.log('--- idempotence: the row is detectable before appending ---')
{
  const once = appendEntry(`${HEADER}\n[]\n`)
  check('a fresh patch does not yet carry our row', hasOwnRow(`${HEADER}\n[]\n`), false)
  check('after one install it does', hasOwnRow(once), true)

  const twice = appendEntry(once)
  const occurrences = twice.split('name: dsh-cost-meter').length - 1
  // appendEntry itself is pure; the caller is what guards with hasOwnRow. This
  // asserts that a second naive append is DETECTABLE, which is the guard's job.
  check('a second append would duplicate the row (hence the guard)', occurrences, 2)
}

console.log('--- the patch row is valid YAML shape and self-consistent ---')
{
  checkTruthy('it is an insert list', PATCH_ROW.includes('- insert:'))
  checkTruthy('it carries exactly one row', PATCH_ROW.split('- id:').length - 1 === 1)
  checkTruthy('its ids match', PATCH_ROW.includes('id: cost-meter') && PATCH_ROW.includes('name: dsh-cost-meter'))
  checkTruthy('it configures the credential reference', PATCH_ROW.includes('apiKeyEnv: DEEPSEEK_API_KEY'))
  checkTruthy('it configures an independent balance endpoint', PATCH_ROW.includes('balanceBaseURL: https://api.deepseek.com'))
}

console.log('')
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
