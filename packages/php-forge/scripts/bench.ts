// Banc d'essai sur des projets réels, en local uniquement : PHP_FORGE_CORPUS=/projet1:/projet2 npm run bench
// Mesure l'indexation (temps, mémoire, symboles, erreurs de syntaxe) et compare avec la mesure précédente.
// Les résultats vont dans bench-results/ (ignoré par git) : aucun fichier des projets n'est copié.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { URI } from 'vscode-uri';
import { complete } from '../src/server/completion/complete.ts';
import { DocumentStore } from '../src/server/documents.ts';
import { collectDiagnostics, semanticPart, type CollectEnv } from '../src/server/diagnostics/collect.ts';
import { isLibrary } from '../src/server/diagnostics/policy.ts';
import { IncludeAnalysis } from '../src/server/includes/analysis.ts';
import { IncludeGraph } from '../src/server/includes/graph.ts';
import { indexFolder } from '../src/server/index/indexer.ts';
import { Lookup } from '../src/server/index/lookup.ts';
import { decode } from '../src/server/parser/encoding.ts';
import { findReferences, type RefEnv } from '../src/server/refactor/references.ts';
import { loadStubs } from '../src/server/stubs/stubs.ts';
import { TypeResolver } from '../src/server/types/expand.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { createParser, initParser, parsePhp } from '../src/server/parser/parser.ts';
import { DEFAULT_SETTINGS, DEFAULT_STUBS } from '../src/shared/protocol.ts';

interface Result {
  project: string;
  files: number;
  parsed: number;
  skipped: number;
  syntaxErrors: number;
  symbols: number;
  ms: number;
  heapMB: number;
  completionP50: number;
  completionP95: number;
  /** Analyse des inclusions (graphe + exécution), en ms */
  analysisMs: number;
  workspaceDiagnosticsMs: number;
  /** Références des 20 fonctions les plus utilisées : moyenne et maximum (ms), total trouvé */
  referencesMs: number;
  referencesMaxMs: number;
  referencesCount: number;
  entries: number;
  byCode: Record<string, number>;
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

const stubs = loadStubs(path.join(import.meta.dirname, '..', 'dist', 'stubs.json.gz'), DEFAULT_STUBS);
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0);
};

/** Complétions (variables, noms, membres) à la fin des 20 plus gros fichiers du projet. */
function completionTimings(index: SymbolIndex, root: string): number[] {
  const resolver = new TypeResolver(new Lookup(index, stubs), '8.3');
  const store = new DocumentStore(parser);
  const files = [...index.files()]
    .map((f) => URI.parse(f.uri).fsPath)
    .map((file) => ({ file, size: statSync(file).size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 20);
  const timings: number[] = [];
  for (const { file } of files) {
    const text = decode(readFileSync(file));
    const reopen = /\?>\s*$/.test(text) || !text.includes('<?php') ? '\n<?php' : '';
    for (const suffix of ['\n$', '\nstr', "\n$pdo = new PDO('x');\n$pdo->"]) {
      const source = text + reopen + suffix;
      const doc = store.open('file:///bench.php', 'php', 1, source);
      const started = performance.now();
      complete({ resolver, parser, folders: [root] }, doc, doc.doc.positionAt(source.length));
      timings.push(performance.now() - started);
    }
  }
  store.close('file:///bench.php');
  return timings;
}

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
  const timings = completionTimings(index, root);
  const analysisStart = performance.now();
  const graph = new IncludeGraph(index, { roots: [root] });
  const analysis = new IncludeAnalysis(index, new Lookup(index, stubs), graph, { maxContexts: 64, externalGlobals: [] });
  analysis.run();
  const analysisMs = Math.round(performance.now() - analysisStart);
  // Passe des diagnostics du workspace (fichiers hors librairie), comme le serveur en arrière-plan
  const byCode: Record<string, number> = {};
  const libraryPaths = ['**/vendor/**', '**/PHPExcel/**', '**/Google/Api/**'];
  const env: CollectEnv = {
    parser,
    resolver: new TypeResolver(new Lookup(index, stubs), process.env.PHP_FORGE_VERSION ?? '7.3'),
    analysis,
    rules: {},
    library: (fsPath) => isLibrary(fsPath, [root], libraryPaths, []),
    baseline: () => undefined,
  };
  const workspaceStart = performance.now();
  for (const file of index.files()) {
    const fsPath = URI.parse(file.uri).fsPath;
    if (!file.flow || env.library(fsPath)) continue;
    const text = decode(readFileSync(fsPath));
    const tree = parsePhp(parser, text);
    const input = { uri: file.uri, fsPath, symbols: file, tree, text };
    for (const d of collectDiagnostics(input, env, semanticPart(input, env)).diagnostics) byCode[String(d.code)] = (byCode[String(d.code)] ?? 0) + 1;
    tree.delete();
  }
  const workspaceDiagnosticsMs = Math.round(performance.now() - workspaceStart);
  // Références : les 20 fonctions du projet présentes dans le plus de fichiers, fichiers relus comme par le serveur
  const refEnv: RefEnv = {
    lookup: env.resolver.lookup,
    resolver: env.resolver,
    files: () => [...index.files()],
    source: (uri) => {
      const symbols = index.get(uri);
      if (!symbols) return undefined;
      const text = decode(readFileSync(URI.parse(uri).fsPath));
      const tree = parsePhp(parser, text);
      return { file: { uri, text, tree, symbols }, release: () => tree.delete() };
    },
  };
  const usage = new Map<string, number>();
  for (const file of index.files()) for (const name of file.names ?? []) usage.set(name, (usage.get(name) ?? 0) + 1);
  const functions = [...index.files()].flatMap((file) => file.symbols.filter((s) => s.kind === 'function').map((symbol) => ({ uri: file.uri, symbol })));
  const popular = functions.sort((a, b) => (usage.get(b.symbol.name.toLowerCase()) ?? 0) - (usage.get(a.symbol.name.toLowerCase()) ?? 0)).slice(0, 20);
  const referenceTimes: number[] = [];
  let referencesCount = 0;
  for (const declaration of popular) {
    const start = performance.now();
    referencesCount += findReferences(refEnv, { kind: 'function', name: declaration.symbol.name, declarations: [declaration] }, false).length;
    referenceTimes.push(performance.now() - start);
  }
  const referencesMs = Math.round(referenceTimes.reduce((a, b) => a + b, 0) / Math.max(1, referenceTimes.length));
  const referencesMaxMs = Math.round(Math.max(0, ...referenceTimes));
  results.push({
    project: path.basename(root), files: stats.files, parsed: stats.parsed, skipped: stats.skipped, syntaxErrors: stats.syntaxErrors,
    symbols, ms: stats.ms, heapMB: Math.round(process.memoryUsage().heapUsed / 1e6),
    completionP50: percentile(timings, 50), completionP95: percentile(timings, 95),
    analysisMs, entries: graph.entries().length, workspaceDiagnosticsMs, referencesMs, referencesMaxMs, referencesCount, byCode,
  });
}
console.table(results.map(({ byCode, ...r }) => r));
for (const r of results) console.log(r.project, JSON.stringify(r.byCode));

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
