// Projet de référence SQL : « // expect: <code> » sur la ligne ; seules les alertes sql-* sont comparées (le
// projet n'a pas d'inclusions : $db et $id sont des variables non définies, hors sujet ici).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { URI } from 'vscode-uri';
import { collectDiagnostics, semanticPart, type CollectEnv } from '../src/server/diagnostics/collect.ts';
import { indexFileSync } from '../src/server/index/indexFile.ts';
import { Lookup } from '../src/server/index/lookup.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { parsePhp } from '../src/server/parser/parser.ts';
import { loadSchema } from '../src/server/sql/sources.ts';
import { TypeResolver } from '../src/server/types/expand.ts';
import { DEFAULT_SETTINGS } from '../src/shared/protocol.ts';
import { parser } from './helpers.ts';

const ROOT = path.join(import.meta.dirname, 'fixtures/sql-schema');

describe('projet de référence SQL', async () => {
  const p = await parser();
  const file = path.join(ROOT, 'index.php');
  const symbols = indexFileSync(p, file, 2_000_000)!;
  const index = new SymbolIndex();
  index.set(symbols);
  const { schema, errors } = loadSchema({ folders: [ROOT], globs: DEFAULT_SETTINGS.sql.schema, exclude: DEFAULT_SETTINGS.exclude });
  const env: CollectEnv = {
    parser: p,
    resolver: new TypeResolver(new Lookup(index, new SymbolIndex()), '8.3'),
    rules: {},
    library: () => false,
    baseline: () => undefined,
    schema,
  };

  it('schéma : deux fichiers, factures partielle', () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(schema.tables.map((t) => `${t.name}:${t.complete}`).sort(), ['clients:true', 'contrats:true', 'factures:false']);
  });

  it('index.php', () => {
    const text = readFileSync(file, 'utf8');
    const tree = parsePhp(p, text);
    const input = { uri: URI.file(file).toString(), fsPath: file, symbols, tree, text };
    const diagnostics = collectDiagnostics(input, env, semanticPart(input, env)).diagnostics.filter((d) => String(d.code).startsWith('sql-'));
    tree.delete();
    const expected = text.split('\n').flatMap((line, row) => {
      const match = /\/\/ expect: ([\w-]+)/.exec(line);
      return match ? [`${row}:${match[1]}`] : [];
    });
    assert.deepEqual(diagnostics.map((d) => `${d.range.start.line}:${d.code}`).sort(), expected.sort(), diagnostics.map((d) => `${d.range.start.line + 1} ${d.message}`).join(' | '));
  });
});
