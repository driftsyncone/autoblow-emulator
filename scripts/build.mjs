// Builds dist/ from src/: strips the TypeScript types with Node's own tool (no dependencies) and
// points the imports at the .js files, so the emulator runs on Node 18 and later.
// Needs Node 22.13+ or 23.2+ to run (`stripTypeScriptTypes`); dist/ is committed, so users don't.
//   node scripts/build.mjs           write dist/
//   node scripts/build.mjs --check   fail if dist/ is out of date (CI)
import { stripTypeScriptTypes } from 'node:module'
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const check = process.argv.includes('--check')
const stale = []
mkdirSync(join(root, 'dist'), { recursive: true })
for (const file of readdirSync(join(root, 'src')).filter((f) => f.endsWith('.ts'))) {
  const src = readFileSync(join(root, 'src', file), 'utf8')
  const js = stripTypeScriptTypes(src, { mode: 'strip' }).replace(/(from\s+['"]\.\/[^'"]+)\.ts(['"])/g, '$1.js$2')
  const out = join(root, 'dist', file.replace(/\.ts$/, '.js'))
  if (check) {
    if (!existsSync(out) || readFileSync(out, 'utf8') !== js) stale.push(file)
  } else writeFileSync(out, js)
}
if (check && stale.length) {
  console.error(`dist/ is out of date for: ${stale.join(', ')}. Run: node scripts/build.mjs`)
  process.exit(1)
}
if (!check) console.log('built dist/')
