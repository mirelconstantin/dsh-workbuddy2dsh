/**
 * Static contract check for the plugin manifest.
 *
 * Every rule here encodes a failure that is expensive to discover at runtime:
 * a `default` export that makes DSH discard the namespace plugin (DSH
 * post-mortem 0001), a bundle patch that inserts a row naming a package npm
 * will not ship, a `files` entry that points at nothing, or a locale file that
 * is not JSON. None of it needs the host to be running, so it runs in CI and
 * before `npm publish`.
 *
 * Run with `npm run check`. Exits non-zero with one line per violation.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

const fail = (message) => failures.push(message)
const read = (relative) => readFileSync(join(root, relative), 'utf8')
const readJson = (relative) => JSON.parse(read(relative))
/** Compare manifest paths without caring about a leading `./`. */
const normalize = (value) => String(value ?? '').replace(/^\.\//, '')

// ---------------------------------------------------------------- manifest

const pkg = readJson('package.json')

for (const field of ['name', 'version', 'description', 'license']) {
  if (typeof pkg[field] !== 'string' || pkg[field].length === 0) fail(`package.json: ${field} is missing`)
}
if (pkg.type !== 'module') fail('package.json: "type" must be "module" — the host loads ESM only')
if (pkg.main !== 'index.js') fail(`package.json: "main" must be "index.js", found ${JSON.stringify(pkg.main)}`)
if (pkg.exports?.['.'] !== './index.js') fail('package.json: exports["."] must be "./index.js"')

// A profile resolves the bundle by package name, so the patch has to be
// declared here rather than discovered.
const patchPath = pkg.dsh?.bundle?.patch
if (typeof patchPath !== 'string') {
  fail('package.json: dsh.bundle.patch is missing — a profile cannot find the plugin row without it')
} else if (!existsSync(join(root, patchPath))) {
  fail(`package.json: dsh.bundle.patch points at ${patchPath}, which does not exist`)
}

if (typeof pkg.dsh?.compatibility?.dshReleases !== 'object') {
  fail('package.json: dsh.compatibility.dshReleases is missing — the host reads it to refuse an untested release')
}
if (typeof pkg.engines?.dsh !== 'string') fail('package.json: engines.dsh is missing')

// The host supplies schemastery; declaring it as a peer is what keeps the
// plugin from vendoring a second copy of the schema validator.
if (!pkg.peerDependencies?.['@deepseek-ai/schemastery']) {
  fail('package.json: @deepseek-ai/schemastery must be a peer dependency')
}
if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
  notes.push(`dependencies is non-empty (${Object.keys(pkg.dependencies).join(', ')}) — a plugin should rely on the host`)
}

// Every published path must exist, or npm silently ships a package whose
// declared surface is incomplete.
const published = (pkg.files ?? []).map(normalize)
for (const entry of pkg.files ?? []) {
  if (!existsSync(join(root, entry))) fail(`package.json: files entry "${entry}" does not exist`)
}
if (!published.includes('index.js')) fail('package.json: files must include index.js')
if (typeof patchPath === 'string' && !published.includes(normalize(patchPath))) {
  fail(`package.json: files must include ${patchPath}`)
}

// Runtime state must never be published: it holds account material.
for (const forbidden of ['_runtime', 'node_modules', 'test']) {
  if (published.includes(forbidden)) fail(`package.json: files must not include ${forbidden}`)
}

// ------------------------------------------------------------- entry module

const entry = read('index.js')

// DSH post-mortem 0001: a `default` export next to named exports makes the
// Loader discard the namespace and the plugin crashes on first use.
if (/^\s*export\s+default\b/m.test(entry)) {
  fail('index.js: export default is forbidden — DSH discards the namespace plugin (post-mortem 0001)')
}

const pluginName = /^export const name = '([^']+)'/m.exec(entry)?.[1]
if (!pluginName) fail("index.js: export const name = '<id>' is missing")

for (const declaration of ['export const inject', 'export const Config', 'export function apply']) {
  if (!entry.includes(declaration)) fail(`index.js: ${declaration} is missing`)
}

// The gateway must come up in a composition that composes no settings service,
// which only holds while nothing is injected at load time.
if (!/^export const inject = \[\]$/m.test(entry)) {
  fail('index.js: inject must be an empty array — the seams are resolved lazily by the runtime')
}

// ------------------------------------------------------------ bundle patch

if (typeof patchPath === 'string' && existsSync(join(root, patchPath))) {
  const patch = read(patchPath)
  if (!/^-\s+insert:/m.test(patch)) fail(`${patchPath}: no "insert:" row — the bundle would add nothing`)
  const patchName = /name:\s*'([^']+)'/.exec(patch)?.[1]
  if (patchName !== pkg.name) {
    fail(`${patchPath}: row name ${JSON.stringify(patchName)} must be the package name ${JSON.stringify(pkg.name)}`)
  }
  const patchId = /id:\s*([^\s#]+)/.exec(patch)?.[1]
  if (pluginName && patchId !== pluginName) {
    fail(`${patchPath}: row id ${JSON.stringify(patchId)} must match the plugin name ${JSON.stringify(pluginName)}`)
  }
}

// ------------------------------------------------------------------ locale

for (const file of readdirSync(join(root, 'locale'))) {
  if (!file.endsWith('.json')) continue
  try {
    const locale = readJson(join('locale', file))
    for (const field of ['title', 'description']) {
      if (typeof locale.meta?.[field] !== 'string') fail(`locale/${file}: meta.${field} is missing`)
    }
  } catch (err) {
    fail(`locale/${file}: not valid JSON (${err.message})`)
  }
}
if (!existsSync(join(root, 'locale', 'en.json'))) fail('locale/en.json is missing')

// ------------------------------------------------------------------ source

// Every module under src/ must be reachable from the entry, or it is dead
// weight that the tests would not cover either.
const srcFiles = readdirSync(join(root, 'src')).filter((file) => file.endsWith('.js'))
for (const file of srcFiles) {
  const specifier = `./src/${file}`
  if (!entry.includes(specifier)) fail(`src/${file}: not re-exported or imported by index.js`)
}

// Relative imports inside src/ must resolve, including the extension.
for (const file of srcFiles) {
  const source = read(join('src', file))
  for (const match of source.matchAll(/from\s+'(\.\/[^']+)'/g)) {
    const target = join(root, 'src', match[1])
    if (!existsSync(target)) fail(`src/${file}: imports ${match[1]}, which does not exist`)
  }
}

// ------------------------------------------------------------------ README

const readme = read('README.md')

// Every relative link in the README must resolve. A dead link in the page a
// user reads first costs more than any other single defect, and nothing else
// in this check would catch one.
const linkTargets = [...readme.matchAll(/\]\((?!https?:|mailto:|#)([^)]+)\)/g)].map((m) =>
  decodeURIComponent(m[1].split('#')[0]).trim(),
)
for (const target of linkTargets) {
  if (target === '') continue
  if (!existsSync(join(root, target))) fail(`README.md: links to ${target}, which does not exist`)
}

const modelExperience = readme.indexOf('\n## Model Experience')
const limitations = readme.indexOf('\n## Known Limitations and Deferred Work')

if (modelExperience === -1) {
  fail('README.md: missing the "## Model Experience" section (docs/cookbook/adding-a-package.md §4)')
} else if (limitations === -1) {
  fail('README.md: missing the "## Known Limitations and Deferred Work" section')
} else if (limitations < modelExperience) {
  fail('README.md: "## Known Limitations and Deferred Work" must follow "## Model Experience"')
} else {
  if (!/^#### KV Cache effect$/m.test(readme.slice(modelExperience))) {
    fail('README.md: "## Model Experience" needs a "#### KV Cache effect" field')
  }
  if (readme.slice(limitations).split('\n').filter((line) => line.startsWith('- **')).length === 0) {
    fail('README.md: "## Known Limitations and Deferred Work" needs at least one "- **…**" entry')
  }
}

// ------------------------------------------------------------------ client

// The browser half is a separate artifact with its own contract. Each rule here
// encodes a failure that is invisible until the chip silently never renders.
if (!existsSync(join(root, 'tsdown.client.config.ts'))) {
  fail('tsdown.client.config.ts is missing — the browser half has no build')
}

const clientEntry = join(root, 'src', 'client', 'index.ts')
if (!existsSync(clientEntry)) {
  fail('src/client/index.ts is missing — the browser half has no entry')
} else {
  const client = read('src/client/index.ts')
  // DSH post-mortem 0001 applies to the browser half too: a default export
  // next to named exports makes the loader discard the namespace.
  if (/^\s*export\s+default\b/m.test(client)) {
    fail('src/client/index.ts: export default is forbidden — DSH discards the namespace (post-mortem 0001)')
  }
  if (!/^export const inject = \['slots', 'locale'\]$/m.test(client)) {
    fail("src/client/index.ts: inject must be exactly ['slots', 'locale']")
  }
  if (!client.includes("'conversation.composer.dock'")) {
    fail("src/client/index.ts: no registration on 'conversation.composer.dock' — the chip would never render")
  }
  // The locale contract is Record<BuiltInLocaleId, …>, and the ids are fixed
  // to exactly zh + en. A dictionary missing either will not load.
  if (!/\bzh\b/.test(client) || !/\ben\b/.test(client)) {
    fail('src/client/index.ts: the locale registration must supply both zh and en')
  }
}

// One CSS module only. A second .module.css gives the bundle a second style
// tag, and the loader keys its tags per file.
const cssModules = existsSync(join(root, 'src', 'client'))
  ? readdirSync(join(root, 'src', 'client')).filter((file) => file.endsWith('.module.css'))
  : []
if (cssModules.length > 1) {
  fail(`src/client: ${cssModules.length} CSS modules (${cssModules.join(', ')}) — the bundle must carry exactly one`)
}

// --------------------------------------------------------------- licensing

for (const file of ['LICENSE', 'NOTICE']) {
  if (!existsSync(join(root, file))) fail(`${file} is missing — a derivative of an MIT project must keep both`)
}

// ------------------------------------------------------------------ report

for (const note of notes) console.log(`note: ${note}`)

if (failures.length > 0) {
  for (const failure of failures) console.error(`error: ${failure}`)
  console.error(`\n${failures.length} problem(s) found`)
  process.exit(1)
}

console.log(`ok: ${pkg.name}@${pkg.version} — manifest, entry, patch, locale, sources and README all check out`)
