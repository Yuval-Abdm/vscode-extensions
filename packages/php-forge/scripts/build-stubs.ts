// Génère dist/stubs.json.gz depuis JetBrains/phpstorm-stubs (tag figé, cloné dans .cache/).
// Sauté si dist/stubs.tag correspond déjà au tag ; --force pour régénérer.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { indexFileSync } from '../src/server/index/indexFile.ts';
import { listPhpFiles } from '../src/server/index/scan.ts';
import { createParser, initParser } from '../src/server/parser/parser.ts';
import { STUBS_FORMAT, STUBS_TAG } from '../src/server/stubs/stubs.ts';
import type { FileSymbols } from '../src/shared/types.ts';

const root = path.join(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const out = path.join(dist, 'stubs.json.gz');
const tagFile = path.join(dist, 'stubs.tag');
const source = path.join(root, '.cache', `phpstorm-stubs-${STUBS_TAG}`);
const stamp = `${STUBS_TAG}#${STUBS_FORMAT}`;

if (!process.argv.includes('--force') && existsSync(out) && existsSync(tagFile) && readFileSync(tagFile, 'utf8') === stamp) {
  console.log(`stubs ${STUBS_TAG} déjà générés`);
  process.exit(0);
}

if (!existsSync(source)) {
  mkdirSync(path.dirname(source), { recursive: true });
  execFileSync('git', ['clone', '--quiet', '--depth', '1', '--branch', STUBS_TAG, 'https://github.com/JetBrains/phpstorm-stubs.git', source], { stdio: 'inherit' });
}

const require = createRequire(import.meta.url);
await initParser({
  treeSitter: require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
  php: require.resolve('tree-sitter-php/tree-sitter-php.wasm'),
});
const parser = createParser();
const files: FileSymbols[] = [];
// Fichiers à la racine (PhpStormStubsMap.php…), tests et méta-données : pas des stubs
for (const file of await listPhpFiles(source, ['*.php', 'tests/**', 'meta/**', '.github/**'])) {
  const symbols = indexFileSync(parser, file, 20_000_000);
  if (!symbols?.symbols.length) continue;
  symbols.uri = `phpstub:/${path.relative(source, file).split(path.sep).join('/')}`;
  symbols.includes = [];
  delete symbols.flow;
  files.push(symbols);
}
mkdirSync(dist, { recursive: true });
writeFileSync(out, gzipSync(JSON.stringify({ format: STUBS_FORMAT, tag: STUBS_TAG, files })));
writeFileSync(tagFile, stamp);
console.log(`stubs ${STUBS_TAG} : ${files.length} fichiers → ${path.relative(root, out)}`);
