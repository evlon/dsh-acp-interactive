// Bundle the tsc-emitted lib/types/*.js into the published lib/*.js layout.
// tsc (with rewriteRelativeImportExtensions) emits per-file ESM under
// lib/types/; this script bundles the three entry points to lib/ and deletes
// the intermediate .js artifacts, keeping only the .d.ts declarations that
// package.json "types" points at.
import { build } from 'esbuild'
import { rmSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const entries = ['index', 'compose', 'bin']

for (const name of entries) {
  await build({
    entryPoints: [resolve(root, `lib/types/${name}.js`)],
    outfile: resolve(root, `lib/${name}.js`),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    // Keep the official @deepseek-ai/* and @agentclientprotocol/* packages
    // external — they resolve from the consumer's node_modules at runtime.
    external: ['@deepseek-ai/*', '@agentclientprotocol/*'],
  })
}

// Remove the intermediate tsc-emitted runtime JS, keeping only the .d.ts and
// .d.ts.map that the "types" entries reference.
for (const name of entries) {
  for (const ext of ['js', 'js.map']) {
    const p = resolve(root, `lib/types/${name}.${ext}`)
    if (existsSync(p)) rmSync(p)
  }
}

console.log('bundle: wrote lib/{index,compose,bin}.js')
