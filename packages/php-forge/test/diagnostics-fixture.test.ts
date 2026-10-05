// Projet de référence des diagnostics : « // expect: <code> » sur la ligne ; aucune autre alerte admise ;
// les dossiers librairie (vendor) ne sont jamais diagnostiqués.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { URI } from 'vscode-uri';
import { collectDiagnostics, semanticPart, type CollectEnv } from '../src/server/diagnostics/collect.ts';
import { isLibrary } from '../src/server/diagnostics/policy.ts';
import { IncludeAnalysis } from '../src/server/includes/analysis.ts';
import { IncludeGraph } from '../src/server/includes/graph.ts';
import { indexFileSync } from '../src/server/index/indexFile.ts';
import { Lookup } from '../src/server/index/lookup.ts';
import { listPhpFiles } from '../src/server/index/scan.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { parsePhp } from '../src/server/parser/parser.ts';
import { loadStubs } from '../src/server/stubs/stubs.ts';
import { DEFAULT_STUBS } from '../src/shared/protocol.ts';
import { TypeResolver } from '../src/server/types/expand.ts';
import { parser } from './helpers.ts';

const ROOT = path.join(import.meta.dirname, 'fixtures/diagnostics');

describe('projet de référence diagnostics', async () => {
  const p = await parser();
  const files = await listPhpFiles(ROOT);
  const index = new SymbolIndex();
  for (const file of files) {
    const symbols = indexFileSync(p, file, 2_000_000);
    if (symbols) index.set(symbols);
  }
  // Fonctions natives (time, function_exists…) : stubs générés par le build
  const lookup = new Lookup(index, loadStubs(path.join(import.meta.dirname, '../dist/stubs.json.gz'), DEFAULT_STUBS));
  const graph = new IncludeGraph(index, { roots: [ROOT] });
  const analysis = new IncludeAnalysis(index, lookup, graph, { maxContexts: 64, externalGlobals: [] });
  analysis.run();
  const env: CollectEnv = {
    parser: p,
    resolver: new TypeResolver(lookup, '8.3'),
    analysis,
    rules: {},
    library: (fsPath) => isLibrary(fsPath, [ROOT], ['**/vendor/**'], []),
    baseline: () => undefined,
  };

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    it(rel, () => {
      const text = readFileSync(file, 'utf8');
      const uri = URI.file(file).toString();
      const tree = parsePhp(p, text);
      const input = { uri, fsPath: file, symbols: index.get(uri)!, tree, text };
      const diagnostics = collectDiagnostics(input, env, semanticPart(input, env)).diagnostics;
      tree.delete();
      const expected = text.split('\n').flatMap((line, row) => {
        const match = /\/\/ expect: ([\w-]+)/.exec(line);
        return match ? [`${row}:${match[1]}`] : [];
      });
      assert.deepEqual(diagnostics.map((d) => `${d.range.start.line}:${d.code}`).sort(), expected.sort(), diagnostics.map((d) => `${d.range.start.line + 1} ${d.message}`).join(' | '));
    });
  }
});
