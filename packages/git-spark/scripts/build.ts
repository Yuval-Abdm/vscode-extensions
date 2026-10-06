// Bundle esbuild (CommonJS) de l'extension dans dist/. --dev : sans minification.
import path from 'node:path';
import { build } from 'esbuild';

const root = path.join(import.meta.dirname, '..');
const dev = process.argv.includes('--dev');

// Webview de la vue Commit : script navigateur (IIFE), avec le module du message partagé.
await build({
  entryPoints: [path.join(root, 'src/features/commit/webview.ts')],
  outfile: path.join(root, 'dist/commit-view.js'),
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  minify: !dev,
  logLevel: 'warning',
});

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
