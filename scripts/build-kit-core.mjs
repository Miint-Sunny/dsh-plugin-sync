import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const out = process.argv[2]
if (!out) throw new Error('Usage: node scripts/build-kit-core.mjs OUTPUT.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../src/kit-core.ts', import.meta.url))],
  outfile: resolve(out), bundle: true, platform: 'node', format: 'esm', target: 'node24',
  sourcemap: false, legalComments: 'eof',
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
})
