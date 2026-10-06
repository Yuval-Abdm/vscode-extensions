// Projets de référence de la sécurité (taint/) et de la migration (migration-php56/) : « // expect: <code> » sur la
// ligne ; seules les alertes security-* (resp. migration-*) sont comparées.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { URI } from 'vscode-uri';
import { collectDiagnostics, semanticPart, type CollectEnv } from '../src/server/diagnostics/collect.ts';
import { IncludeAnalysis } from '../src/server/includes/analysis.ts';
import { IncludeGraph } from '../src/server/includes/graph.ts';
import { indexFileSync } from '../src/server/index/indexFile.ts';
import { Lookup } from '../src/server/index/lookup.ts';
import { listPhpFiles } from '../src/server/index/scan.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { parsePhp, type Node, type Parser } from '../src/server/parser/parser.ts';
import { loadStubs } from '../src/server/stubs/stubs.ts';
import { TypeResolver } from '../src/server/types/expand.ts';
import { DEFAULT_STUBS } from '../src/shared/protocol.ts';
import { parser } from './helpers.ts';

const STUBS = path.join(import.meta.dirname, '../dist/stubs.json.gz');

async function project(name: string, version: string, target?: string) {
  const root = path.join(import.meta.dirname, 'fixtures', name);
  const p = await parser();
  const files = await listPhpFiles(root);
  const index = new SymbolIndex();
  for (const file of files) {
    const symbols = indexFileSync(p, file, 2_000_000);
    if (symbols) index.set(symbols);
  }
  const lookup = new Lookup(index, loadStubs(STUBS, DEFAULT_STUBS));
  const graph = new IncludeGraph(index, { roots: [root] });
  const analysis = new IncludeAnalysis(index, lookup, graph, { maxContexts: 64, externalGlobals: [] });
  analysis.run();
  const env: CollectEnv = {
    parser: p,
    resolver: new TypeResolver(lookup, version),
    analysis,
    rules: {},
    library: () => false,
    baseline: () => undefined,
    security: (input) => ({
      uri: input.uri,
      request: (n, at) => analysis.variable(input.uri, n.slice(1), at)?.request,
      requestAtEntry: () => !!analysis.variable(input.uri, '', { line: 0, character: 0 })?.request,
      loadFunction: (fn) => loadFunction(p, index, fn),
    }),
    ...(target ? { target: new TypeResolver(lookup, target) } : {}),
  };
  return { root, files, index, env, p };
}

function loadFunction(p: Parser, index: SymbolIndex, name: string) {
  const hit = index.findFunction(name)[0];
  if (!hit) return undefined;
  const tree = parsePhp(p, readFileSync(URI.parse(hit.uri).fsPath, 'utf8'));
  let node: Node | null = tree.rootNode.descendantForPosition({ row: hit.symbol.selectionRange.start.line, column: hit.symbol.selectionRange.start.character });
  while (node && node.type !== 'function_definition') node = node.parent;
  return node ? { uri: hit.uri, node, release: () => tree.delete() } : undefined;
}

function check(setup: Awaited<ReturnType<typeof project>>, prefix: string) {
  for (const file of setup.files) {
    it(path.relative(setup.root, file), () => {
      const text = readFileSync(file, 'utf8');
      const uri = URI.file(file).toString();
      const tree = parsePhp(setup.p, text);
      const input = { uri, fsPath: file, symbols: setup.index.get(uri)!, tree, text };
      const diagnostics = collectDiagnostics(input, setup.env, semanticPart(input, setup.env)).diagnostics.filter((d) => String(d.code).startsWith(prefix));
      tree.delete();
      const expected = text.split('\n').flatMap((line, row) => {
        const match = /\/\/ expect: ([\w-]+)/.exec(line);
        return match ? [`${row}:${match[1]}`] : [];
      });
      assert.deepEqual(diagnostics.map((d) => `${d.range.start.line}:${d.code}`).sort(), expected.sort(), diagnostics.map((d) => `${d.range.start.line + 1} ${d.message}`).join(' | '));
    });
  }
}

describe('projet de référence sécurité (taint/)', { skip: !existsSync(STUBS) }, async () => {
  check(await project('taint', '8.3'), 'security-');
});

describe('projet de référence migration (migration-php56/, PHP 5.6 → 8.0)', { skip: !existsSync(STUBS) }, async () => {
  check(await project('migration-php56', '5.6', '8.0'), 'migration-');
});
