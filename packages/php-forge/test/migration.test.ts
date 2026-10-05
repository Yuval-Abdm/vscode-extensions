import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Diagnostic } from 'vscode-languageserver/node';
import { deprecatedSyntax } from '../src/server/diagnostics/deprecatedSyntax.ts';
import { semanticDiagnostics } from '../src/server/diagnostics/semantic.ts';
import { quickFixes } from '../src/server/features/codeActions.ts';
import { Lookup } from '../src/server/index/lookup.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { migrationDiagnostics } from '../src/server/migration/migration.ts';
import { loadStubs } from '../src/server/stubs/stubs.ts';
import { TypeResolver } from '../src/server/types/expand.ts';
import { DEFAULT_STUBS } from '../src/shared/protocol.ts';
import { extract, parse } from './helpers.ts';

const STUBS = path.join(import.meta.dirname, '../dist/stubs.json.gz');
const URI = 'file:///p/a.php';

async function migrate(code: string, from: string, to: string): Promise<{ diagnostics: Diagnostic[]; code: string }> {
  const tree = await parse(code);
  const symbols = await extract(code, URI);
  const index = new SymbolIndex();
  index.set(symbols);
  const lookup = new Lookup(index, loadStubs(STUBS, DEFAULT_STUBS));
  const resolver = new TypeResolver(lookup, from);
  const current = [...semanticDiagnostics(symbols, tree, resolver), ...deprecatedSyntax(tree, code, from)];
  return { diagnostics: migrationDiagnostics({ symbols, tree, text: code }, current, resolver, new TypeResolver(lookup, to)), code };
}

const list = (ds: Diagnostic[]) => ds.map((d) => `${d.range.start.line}:${d.code}`);

function apply(code: string, d: Diagnostic): string {
  const [fix] = quickFixes(URI, [d]);
  const lines = code.split('\n');
  const offset = (p: { line: number; character: number }) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  const edits = [...(fix.edit?.changes?.[URI] ?? [])].sort((a, b) => offset(b.range.start) - offset(a.range.start));
  let text = code;
  for (const e of edits) text = text.slice(0, offset(e.range.start)) + e.newText + text.slice(offset(e.range.end));
  return text;
}

describe('migration de version PHP', { skip: !existsSync(STUBS) }, () => {
  it('7.3 → 8.2 : API supprimées et dépréciées, syntaxe, comparaisons, propriétés dynamiques', async () => {
    const { diagnostics } = await migrate([
      '<?php',
      '$r = each($tab);',
      '$s = utf8_encode($t);',
      '$x = (real)$y;',
      'if ($_GET["n"] == 0) {}',
      'if ($n == 0) {}',
      'class A { function f() { $this->p = 1; } }',
      '#[AllowDynamicProperties] class B { function f() { $this->q = 1; } }',
      '$m = mysql_query("x");',
    ].join('\n'), '7.3', '8.2');
    assert.deepEqual(list(diagnostics), ['1:migration-removed-api', '2:migration-deprecated-api', '3:migration-syntax', '4:migration-behavior', '6:migration-dynamic-property']);
    assert.match(String(diagnostics[0].message), /^PHP 8\.2: each\(\) was removed in PHP 8\.0/);
  });

  it('rien quand la cible n’est pas plus récente ; rien de ce qui est déjà signalé', async () => {
    assert.deepEqual(list((await migrate('<?php $r = each($tab);', '8.2', '8.0')).diagnostics), []);
    assert.deepEqual(list((await migrate('<?php $r = each($tab);', '8.0', '8.3')).diagnostics), []);
  });

  it('each hors de while (list(…) = each(…)) : pas de correction', async () => {
    const { diagnostics } = await migrate('<?php\n$r = each($tab);\n', '7.3', '8.0');
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(quickFixes(URI, diagnostics), []);
  });

  it('corrections : each → foreach, create_function → closure', async () => {
    const loop = await migrate('<?php\nwhile (list($k, $v) = each($tab)) {\n  echo $k;\n}\nwhile (list(, $w) = each($t2)) {}\n', '7.3', '8.0');
    const [first, second] = loop.diagnostics;
    assert.equal(apply(loop.code, first), '<?php\nforeach ($tab as $k => $v) {\n  echo $k;\n}\nwhile (list(, $w) = each($t2)) {}\n');
    assert.equal(apply(loop.code, second), '<?php\nwhile (list($k, $v) = each($tab)) {\n  echo $k;\n}\nforeach ($t2 as $w) {}\n');
    const fn = await migrate(`<?php\n$f = create_function('$a,$b', 'return $a + $b;');\n`, '7.2', '8.0');
    assert.equal(apply(fn.code, fn.diagnostics[0]), '<?php\n$f = function ($a, $b) { return $a + $b; };\n');
  });
});

describe('rapport de migration', () => {
  it('par règle puis par fichier, fichiers les plus touchés d’abord', async () => {
    const { migrationReport } = await import('../src/server/migration/report.ts');
    const report = migrationReport([
      { path: 'a.php', problems: [{ line: 4, code: 'migration-syntax', message: 'PHP 8.0: x' }] },
      { path: 'lib/b.php', problems: [{ line: 9, code: 'migration-removed-api', message: 'PHP 8.0: each() was removed' }, { line: 1, code: 'migration-syntax', message: 'PHP 8.0: y' }] },
      { path: 'c.php', problems: [] },
    ], '7.3', '8.0');
    assert.equal(report, [
      '# Migration report: PHP 7.3 → PHP 8.0',
      '',
      '3 problems in 2 files.',
      '',
      '## By rule',
      '',
      '| Rule | Problems | Files |',
      '|---|---:|---:|',
      '| `migration-syntax` | 2 | 2 |',
      '| `migration-removed-api` | 1 | 1 |',
      '',
      '## By file',
      '',
      '### lib/b.php (2)',
      '',
      '- line 2 — `migration-syntax` — PHP 8.0: y',
      '- line 10 — `migration-removed-api` — PHP 8.0: each() was removed',
      '',
      '### a.php (1)',
      '',
      '- line 5 — `migration-syntax` — PHP 8.0: x',
      '',
    ].join('\n'));
    assert.match(migrationReport([], '7.3', '8.0'), /No problem found/);
  });
});
