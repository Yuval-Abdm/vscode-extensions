// Projet de référence des inclusions (spec §9) : chaque diagnostic attendu est écrit sur sa ligne
// (« // expect: <code> [extrait du message] ») ; aucune autre alerte d'inclusion n'est admise.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { URI } from 'vscode-uri';
import { IncludeAnalysis } from '../src/server/includes/analysis.ts';
import { callerLabel, includeDiagnostics } from '../src/server/includes/diagnostics.ts';
import { IncludeGraph } from '../src/server/includes/graph.ts';
import { indexFileSync } from '../src/server/index/indexFile.ts';
import { Lookup } from '../src/server/index/lookup.ts';
import { listPhpFiles } from '../src/server/index/scan.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { parser } from './helpers.ts';

const ROOT = path.join(import.meta.dirname, 'fixtures/legacy-includes');

describe('projet de référence legacy-includes', async () => {
  const p = await parser();
  const files = await listPhpFiles(ROOT);
  const index = new SymbolIndex();
  for (const file of files) {
    const symbols = indexFileSync(p, file, 2_000_000);
    if (symbols) index.set(symbols);
  }
  const graph = new IncludeGraph(index, { roots: [ROOT] });
  const analysis = new IncludeAnalysis(index, new Lookup(index, new SymbolIndex()), graph, { maxContexts: 64, externalGlobals: [] });
  analysis.run();

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    it(rel, () => {
      const uri = URI.file(file).toString();
      const report = analysis.report(uri) ?? { reads: [], symbols: [], unresolved: [], duplicates: [], approximate: false, contexts: [] };
      const diagnostics = includeDiagnostics(report, index.get(uri)!, (via) => callerLabel(graph, via));
      const expected = readFileSync(file, 'utf8').split('\n').flatMap((text, line) => {
        const match = /\/\/ expect: ([\w-]+)(?: (.+))?$/.exec(text);
        return match ? [{ line, code: match[1], mention: match[2]?.trim() }] : [];
      });
      assert.deepEqual(diagnostics.map((d) => `${d.range.start.line}:${d.code}`).sort(), expected.map((e) => `${e.line}:${e.code}`).sort(), diagnostics.map((d) => d.message).join(' | '));
      for (const e of expected) {
        if (!e.mention) continue;
        const d = diagnostics.find((x) => x.range.start.line === e.line && x.code === e.code)!;
        assert.ok(String(d.message).includes(e.mention), `${rel}:${e.line + 1} « ${d.message} » ne contient pas « ${e.mention} »`);
      }
    });
  }
});
