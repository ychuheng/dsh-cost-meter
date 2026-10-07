/**
 * Build the distributable zip.
 *
 * Ships only what a recipient needs to run the plugin: its two halves, the
 * installer, and the docs. The `verify-*.mjs` suites are development scaffolding
 * — they reach into a live DSH home and assert against this machine's layout, so
 * shipping them would invite a recipient to run something that cannot pass
 * everywhere.
 *
 * Uses PowerShell's Compress-Archive, so there is no dependency to install.
 *
 * Usage: node pack.mjs [outDir]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))

const outDir = resolve(process.argv[2] ?? join(HERE, 'dist'))
const stageDir = join(outDir, `${pkg.name}-${pkg.version}`)
const zipPath = join(outDir, `${pkg.name}-${pkg.version}.zip`)

// The staging directory is derived from the package name and version, and the
// zip path from that same root; verify before removing anything.
if (!stageDir.startsWith(outDir)) {
  console.error(`refusing to clean ${stageDir}: outside ${outDir}`)
  process.exit(1)
}

rmSync(stageDir, { recursive: true, force: true })
mkdirSync(stageDir, { recursive: true })

const INCLUDED = ['lib', 'install.mjs', 'README.md', 'LICENSE', 'package.json']

console.log(`staging ${pkg.name}@${pkg.version} -> ${stageDir}`)
for (const entry of INCLUDED) {
  const source = join(HERE, entry)
  if (!existsSync(source)) {
    console.error(`missing required file: ${entry}`)
    process.exit(1)
  }
  const target = join(stageDir, entry)
  mkdirSync(dirname(target), { recursive: true })
  // -Recurse for directories; -Force to overwrite the clean staging tree.
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Copy-Item -LiteralPath '${source}' -Destination '${target}' -Recurse -Force`], { stdio: 'inherit' })
  console.log(`  + ${entry}`)
}

// Never ship a private flag: some package managers refuse such a package, and
// this tree is meant to be installable.
const stagedPkg = JSON.parse(readFileSync(join(stageDir, 'package.json'), 'utf8'))
if (stagedPkg.private === true) {
  console.error('refusing to pack: package.json still has "private": true')
  process.exit(1)
}

rmSync(zipPath, { force: true })
console.log(`compressing -> ${zipPath}`)
execFileSync(
  'powershell.exe',
  ['-NoProfile', '-Command', `Compress-Archive -Path '${stageDir}' -DestinationPath '${zipPath}' -Force`],
  { stdio: 'inherit' },
)

// Remove the staging directory. It has almost the same name as the zip and
// Explorer draws it with a compressed-folder icon, so leaving it beside the zip
// reads as "there is no zip, only a folder". The zip is the deliverable.
rmSync(stageDir, { recursive: true, force: true })

const size = statSync(zipPath).size
console.log('')
console.log(`done: ${zipPath}  (${(size / 1024).toFixed(1)} KB)`)
console.log(`      staging directory removed: ${stageDir}`)
console.log('')
console.log('Recipient instructions are in README.md inside the zip.')
