// Banc d'essai sur des projets réels, en local uniquement : PHP_FORGE_CORPUS=/projet1:/projet2 npm run bench
// Mesure l'indexation (temps, mémoire, symboles, erreurs de syntaxe) et compare avec la mesure précédente.
// Les résultats vont dans bench-results/ (ignoré par git) : aucun fichier des projets n'est copié.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { indexFolder } from '../src/server/index/indexer.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { createParser, initParser } from '../src/server/parser/parser.ts';
import { DEFAULT_SETTINGS } from '../src/shared/protocol.ts';

interface Result {
  project: string;
  files: number;
  parsed: number;
  skipped: number;
  syntaxErrors: number;
  symbols: number;
  ms: number;
  heapMB: number;
}

const corpus = (process.env.PHP_FORGE_CORPUS ?? '').split(':').filter(Boolean);
if (!corpus.length) {
  console.error('Usage : PHP_FORGE_CORPUS=/chemin/projet1:/chemin/projet2 npm run bench');
  process.exit(1);
}

const require = createRequire(import.meta.url);
const wasm = { treeSitter: require.resolve('web-tree-sitter/web-tree-sitter.wasm'), php: require.resolve('tree-sitter-php/tree-sitter-php.wasm') };
await initParser(wasm);
const parser = createParser();

const results: Result[] = [];
for (const root of corpus) {
  const index = new SymbolIndex();
  const stats = await indexFolder(index, {
    root,
    exclude: DEFAULT_SETTINGS.exclude,
    maxFileSize: DEFAULT_SETTINGS.maxFileSize,
    parser,
    wasm,
    workerScript: path.join(import.meta.dirname, '../src/server/index/worker.ts'),
  });
  const symbols = [...index.files()].reduce((n, f) => n + f.symbols.length, 0);
  results.push({
    project: path.basename(root), files: stats.files, parsed: stats.parsed, skipped: stats.skipped, syntaxErrors: stats.syntaxErrors,
    symbols, ms: stats.ms, heapMB: Math.round(process.memoryUsage().heapUsed / 1e6),
  });
}
console.table(results);

const dir = path.join(import.meta.dirname, '..', 'bench-results');
mkdirSync(dir, { recursive: true });
const previous = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().pop();
if (previous) {
  const old = JSON.parse(readFileSync(path.join(dir, previous), 'utf8')) as Result[];
  console.log(`Comparaison avec ${previous} :`);
  for (const r of results) {
    const o = old.find((x) => x.project === r.project);
    if (o) console.log(`  ${r.project} : ${r.ms - o.ms >= 0 ? '+' : ''}${r.ms - o.ms} ms, symboles ${r.symbols - o.symbols >= 0 ? '+' : ''}${r.symbols - o.symbols}, erreurs de syntaxe ${o.syntaxErrors} → ${r.syntaxErrors}`);
  }
}
writeFileSync(path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(results, null, 2));
