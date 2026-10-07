#!/usr/bin/env node
/**
 * Install dsh-cost-meter into a DSH profile.
 *
 * Why a script rather than instructions: installation needs three things that are
 * each individually easy to get wrong by hand — the package has to become
 * resolvable from the profile directory, a Loader row has to be added to that
 * profile's own patch layer, and the app has to be restarted. This does the first
 * two and reports the third.
 *
 * It never edits `cordis.yml` (the composition root) — only `cordis.patch.yml`,
 * the layer meant for user additions.
 *
 * Usage:
 *   node install.mjs                      # every profile found
 *   node install.mjs --profile desktop    # one profile
 *   node install.mjs --dsh-home <dir>     # override $DSH_HOME
 *   node install.mjs --dry-run            # report what would change
 *
 * Exit codes: 0 changed or already installed, 1 refused or failed.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-cost-meter'
const PATCH_FILENAME = 'cordis.patch.yml'
const HERE = dirname(fileURLToPath(import.meta.url))

/** The Loader row this installer owns, inserted as one patch-list entry. */
const PATCH_ROW = `# ${PACKAGE_NAME}: account balance with a refresh button, and this session's
# cost, as an extra pill in the composer dock's ambient strip.
#
# \`apiKeyEnv\` names a credential REFERENCE; the value is resolved per operation
# through the credentials service and never enters configuration. \`balanceBaseURL\`
# is deliberately independent of $DEEPSEEK_BASE_URL, which may point at an
# internal gateway that does not serve /user/balance.
- insert:
    - id: cost-meter
      name: ${PACKAGE_NAME}
      config:
        apiKeyEnv: DEEPSEEK_API_KEY
        balanceBaseURL: https://api.deepseek.com
`

/** Whether this module is the entry point, or was imported for its helpers. */
const isEntryPoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const options = { profile: undefined, dshHome: undefined, dryRun: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile') options.profile = argv[++i]
    else if (arg === '--dsh-home') options.dshHome = argv[++i]
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else {
      console.error(`unrecognized argument: ${arg}`)
      process.exit(1)
    }
  }
  return options
}

/**
 * Whether this plugin's Loader row is present.
 *
 * The name is matched against one LINE, and the `\s` seen elsewhere is avoided on
 * purpose: `\s` matches a newline, so a pattern like `\s*name:\s*dsh-cost-meter\s*$`
 * can walk across a line break and report a row that is not there — or, without the
 * `m` flag, fail to match a row that is. Only spaces and tabs are horizontal here.
 */
const OWN_ROW_NAME = /^[ \t]*name:[ \t]*['"]?dsh-cost-meter['"]?[ \t]*$/m

/** Whether the patch text already carries this plugin's row. */
function hasOwnRow(text) {
  return OWN_ROW_NAME.test(text)
}

/**
 * Index of this plugin's `name:` line in a pre-split line array, or -1.
 *
 * @param lines - the patch file split on newlines.
 * @returns the 0-based line index.
 */
function ownRowLineIndex(lines) {
  return lines.findIndex((line) => /^[ \t]*name:[ \t]*['"]?dsh-cost-meter['"]?[ \t]*$/.test(line))
}

/** Whether this package declares a bundle patch, which mounts it by itself. */
function declaresBundle() {
  try {
    const manifest = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
    const patch = manifest?.dsh?.bundle?.patch
    return typeof patch === 'string' && patch.length > 0
  } catch {
    return false
  }
}

/**
 * Remove a previously written row for this plugin, leaving everything else alone.
 *
 * Needed when upgrading an install made by an earlier revision: before the package
 * declared `dsh.bundle.patch`, the installer had to hand-write a row, and keeping
 * that row beside the bundle patch would mount the plugin twice under one id.
 *
 * The block is located by its `name:` line and removed outward to the enclosing
 * top-level entry, so comments above it go too and a neighbouring entry is never
 * touched. Returns the text unchanged when no such row exists.
 *
 * @param text - the patch file's contents.
 * @returns the contents without this plugin's row.
 */
function removeOwnRow(text) {
  const lines = text.split(/\r?\n/)
  const nameAt = ownRowLineIndex(lines)
  if (nameAt < 0) return text

  // The entry's own opening line: the nearest column-zero `- ` at or above the
  // name. An indented `    - id: …` never matches, which is what keeps a nested
  // row from being mistaken for the opening line.
  const TOP_LEVEL_ENTRY = /^- /
  let entryAt = nameAt
  while (entryAt > 0 && !TOP_LEVEL_ENTRY.test(lines[entryAt])) entryAt -= 1
  if (!TOP_LEVEL_ENTRY.test(lines[entryAt])) return text

  // The entry ends at the next column-zero `- ` BELOW its opening line. Searching
  // from anywhere else is wrong: the opening line itself matches this pattern, so
  // a search starting above it stops immediately and leaves the row behind.
  let endAt = entryAt + 1
  while (endAt < lines.length && !TOP_LEVEL_ENTRY.test(lines[endAt])) endAt += 1

  // The documented comment block immediately above travels with the entry, plus
  // one blank separator line so nothing is left double-spaced.
  let cutFrom = entryAt
  while (cutFrom > 0 && /^[ \t]*#/.test(lines[cutFrom - 1])) cutFrom -= 1
  if (cutFrom > 0 && lines[cutFrom - 1].trim() === '') cutFrom -= 1

  const kept = lines.slice(0, cutFrom).concat(lines.slice(endAt))

  // A file that held only this row keeps its comment header, trimmed.
  if (kept.every((line) => line.trim() === '' || /^[ \t]*#/.test(line))) {
    return kept.join('\n').replace(/\s+$/u, '') + '\n'
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gmu, '').replace(/\s+$/u, '') + '\n'
}

/**
 * Append one entry to a patch list, preserving everything already there.
 *
 * This is deliberately TEXTUAL and additive. An earlier revision split the file
 * into entries and rebuilt it from those entries plus the new one, which silently
 * DISCARDED the whole file whenever it held no parseable entry — and a profile's
 * patch is exactly that shape while it still contains the scaffold `[]`. A user's
 * existing settings must never be one parse away from deletion.
 *
 * The only content removed is a whole-line scaffold `[]`; every comment line is
 * kept verbatim.
 *
 * @param text - the patch file's current contents.
 * @returns the contents to write.
 */
function appendEntry(text) {
  const withoutScaffold = text.replace(/^\[\]\s*$/m, '')
  const body = withoutScaffold.replace(/\s+$/u, '')
  // An empty body must not leave a blank block before the row.
  return body === '' ? PATCH_ROW : `${body}\n\n${PATCH_ROW}`
}

/**
 * Run the install.
 *
 * Kept inside a function and called ONLY from the entry-point guard: an earlier
 * revision ran at module top level, so merely importing this file for its helpers
 * installed the plugin into every real profile on the machine. A test import must
 * never touch the user's configuration.
 *
 * @param options - parsed command line.
 * @returns the process exit code.
 */
function main(options) {
  const dshHome = resolve(options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const profilesDir = join(dshHome, 'profiles')

  console.log(`dsh home     : ${dshHome}`)
  console.log(`profiles dir : ${profilesDir}`)
  console.log(`package from : ${HERE}`)
  console.log('')

  if (!existsSync(profilesDir)) {
    console.error(`refusing to install: no profiles directory at ${profilesDir}`)
    console.error('Is DSH installed for this user, or is $DSH_HOME pointing elsewhere?')
    return 1
  }

  if (!existsSync(join(HERE, 'lib', 'client.js')) || !existsSync(join(HERE, 'lib', 'index.js'))) {
    console.error(`refusing to install: ${HERE} does not look like the plugin`)
    console.error('lib/index.js and lib/client.js are required; run this from inside the package.')
    return 1
  }

  const profiles =
    options.profile !== undefined
      ? [options.profile]
      : readdirSync(profilesDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
          .map((entry) => entry.name)

  let changed = 0
  let refused = 0

  for (const profile of profiles) {
    console.log(`--- profile: ${profile}`)
    const profileDir = join(profilesDir, profile)

    if (!existsSync(profileDir) || !statSync(profileDir).isDirectory()) {
      console.log(`    skipped: ${profileDir} is not a directory`)
      refused += 1
      console.log('')
      continue
    }

    const patchPath = join(profileDir, PATCH_FILENAME)
    if (!existsSync(patchPath)) {
      console.log(`    skipped: no ${PATCH_FILENAME} (not a DSH profile?)`)
      refused += 1
      console.log('')
      continue
    }

    // 1. Make the package resolvable from the profile directory.
    const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME)
    let linkState = 'present'
    if (!existsSync(linkPath)) {
      linkState = 'created'
      if (!options.dryRun) {
        mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
        try {
          // A junction needs no elevation on Windows and no target semantics on
          // POSIX; 'dir' is the portable fallback.
          symlinkSync(HERE, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
        } catch (error) {
          console.error(`    FAILED to link ${linkPath}: ${error.message}`)
          console.error('    On Windows, creating a link may require Developer Mode or an elevated shell.')
          refused += 1
          console.log('')
          continue
        }
      }
    }
    console.log(`    link      : ${linkPath} (${options.dryRun ? 'would be created' : linkState})`)

    // 2. The Loader row.
    //
    // The row is written even though the package now declares its own bundle
    // patch. The reason is verification, not redundancy: the installer's row is
    // the path that has actually been exercised, while whether a declared bundle
    // is auto-applied depends on the profile's bundle selection — a bundle has to
    // be ENABLED, and that selection lives in the app. Writing the row makes the
    // installer's result independent of that. Loader patches are keyed by id, so
    // the bundle's own row and this one describe the same entry rather than
    // mounting two.
    const text = readFileSync(patchPath, 'utf8')
    if (hasOwnRow(text)) {
      console.log(`    patch     : already contains a ${PACKAGE_NAME} row, left unchanged`)
    } else if (options.dryRun) {
      console.log(`    patch     : would append one insert row to ${patchPath}`)
      changed += 1
    } else {
      writeFileSync(patchPath, appendEntry(text), 'utf8')
      console.log(`    patch     : appended one insert row to ${patchPath}`)
      changed += 1
    }
    console.log('')
  }

  console.log(`profiles changed: ${changed}   skipped/refused: ${refused}`)
  console.log('')
  if (options.dryRun) {
    console.log('Dry run — nothing was written.')
    return 0
  }
  console.log('Next: FULLY QUIT and reopen the DSH app (a profile is composed at startup;')
  console.log('there is no hot reload for this layer). The readout appears in the strip below')
  console.log('the composer, to the right of the token / cache-hit stats.')
  console.log('')
  console.log('If the balance reads "unavailable", store a DeepSeek API key under the')
  console.log('credential reference named in the patch row (default DEEPSEEK_API_KEY) in')
  console.log('Settings > Models, or export it in the environment DSH launches from.')
  return 0
}

if (isEntryPoint) {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('usage: node install.mjs [--profile <name>] [--dsh-home <dir>] [--dry-run]')
    process.exit(0)
  }
  process.exit(main(options))
}

export { PACKAGE_NAME, PATCH_ROW, appendEntry, declaresBundle, hasOwnRow, ownRowLineIndex, parseArgs, removeOwnRow }
