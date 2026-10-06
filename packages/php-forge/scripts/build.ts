// Bundles esbuild (CommonJS) du client, du serveur et du worker d'indexation, et copie des fichiers WASM dans dist/.
// --dev : sans minification (tests).
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build, type BuildOptions, type Plugin } from 'esbuild';

const root = path.join(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const dev = process.argv.includes('--dev');
const require = createRequire(import.meta.url);

/** web-tree-sitter : version CommonJS (la version ESM utilise import.meta, vide dans un bundle CommonJS). */
const treeSitterCjs: Plugin = {
  name: 'web-tree-sitter-cjs',
  setup(b) {
    b.onResolve({ filter: /^web-tree-sitter$/ }, () => ({ path: require.resolve('web-tree-sitter') }));
  },
};

const common: BuildOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  minify: !dev,
  keepNames: true,
  logLevel: 'warning',
  plugins: [treeSitterCjs],
};

mkdirSync(dist, { recursive: true });
await Promise.all([
  build({ ...common, entryPoints: [path.join(root, 'src/client/extension.ts')], outfile: path.join(dist, 'client.cjs'), external: ['vscode'] }),
  build({ ...common, entryPoints: [path.join(root, 'src/server/server.ts')], outfile: path.join(dist, 'server.cjs') }),
  build({ ...common, entryPoints: [path.join(root, 'src/server/index/worker.ts')], outfile: path.join(dist, 'worker.cjs') }),
]);
copyFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'), path.join(dist, 'web-tree-sitter.wasm'));
copyFileSync(require.resolve('tree-sitter-php/tree-sitter-php.wasm'), path.join(dist, 'tree-sitter-php.wasm'));
