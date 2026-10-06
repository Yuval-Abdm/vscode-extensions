// Bundle esbuild (CommonJS) de l'extension dans dist/. --dev : sans minification.
import path from 'node:path';
import { build } from 'esbuild';

const root = path.join(import.meta.dirname, '..');
const dev = process.argv.includes('--dev');

await build({
  entryPoints: [path.join(root, 'src/extension.ts')],
  outfile: path.join(root, 'dist/extension.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  minify: !dev,
  keepNames: true,
  logLevel: 'warning',
  external: ['vscode'],
});
