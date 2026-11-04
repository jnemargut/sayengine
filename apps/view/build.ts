// Bundle the browser view (three.js + view code) into apps/view/dist/main.js.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [path.join(here, 'src/main.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: path.join(here, 'dist/main.js'),
  minify: process.argv.includes('--minify'),
  sourcemap: true,
  logLevel: 'info',
});
