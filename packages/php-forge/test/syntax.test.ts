import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { syntaxDiagnostics } from '../src/server/diagnostics/syntax.ts';
import { quickFixes } from '../src/server/features/codeActions.ts';
import { parse, parser } from './helpers.ts';

async function check(code: string) {
  return syntaxDiagnostics(await parse(code), 100, { parser: await parser(), text: code });
}

function only(diagnostics: Awaited<ReturnType<typeof check>>) {
  assert.equal(diagnostics.length, 1, JSON.stringify(diagnostics.map((d) => d.message)));
  return diagnostics[0];
}

describe('« ; » manquant', () => {
  for (const [label, code, line, character] of [
    ['affectation suivie d’une affectation', '<?php\n$a = 1\n$b = 2;\n', 1, 6],
    ['appel suivi d’un echo', '<?php\n$a = foo()\necho $a;\n', 1, 10],
    ['echo suivi d’une affectation', "<?php\necho 'x'\n$b = 2;\n", 1, 8],
    ['appel de méthode suivi d’un if', "<?php\n$x = $db->query('a')\nif ($x) {}\n", 1, 20],
    ['tableau suivi d’un foreach', "<?php\n$t = ['a' => 1]\nforeach ($t as $v) {}\n", 1, 15],
    ['include suivi d’une affectation', "<?php\ninclude 'a.php'\n$b = 1;\n", 1, 15],
    ['commentaire en fin de ligne', '<?php\n$a = 1 // note\n$b = 2;\n', 1, 6],
    ['ligne vide et commentaire avant la suite', '<?php\n$a = 1\n\n// c\n$b = 2;\n', 1, 6],
    ['élément MISSING de tree-sitter', '<?php\n$a = 1\nreturn $a;\n', 1, 6],
    ['fichier commençant par des lignes vides', '\r\n\r\n<p>a</p>\n<?php\n$a = 1\n$b = 2;\n', 4, 6],
    ['dans une fonction', '<?php\nfunction f() {\n  $a = 1\n}\n', 2, 8],
  ] as const) {
    it(label, async () => {
      const d = only(await check(code));
      assert.equal(d.code, 'missing-semicolon');
      assert.match(String(d.message), /missing ";"/i);
      assert.deepEqual(d.range.end, { line, character });
      assert.equal(d.range.start.line, line);
    });
  }

  it('deux « ; » manquants éloignés', async () => {
    const diagnostics = await check('<?php\n$a = 1\n$b = 2;\nfunction f() {}\n$c = 3\n$d = 4;\n');
    assert.deepEqual(diagnostics.map((d) => [d.code, d.range.end.line]), [['missing-semicolon', 1], ['missing-semicolon', 4]]);
  });

  it('autre erreur : message habituel', async () => {
    const diagnostics = await check('<?php\nfunction f( {\n  $a = ;\n}\n');
    assert.ok(diagnostics.length >= 1);
    assert.ok(diagnostics.every((d) => d.code === 'syntax-error'));
  });

  it('chaîne d’appels sur plusieurs lignes : pas d’erreur', async () => {
    assert.deepEqual(await check('<?php\n$a = $b\n  ->c();\n'), []);
  });

  it('sans analyseur : diagnostic habituel', async () => {
    const [first] = syntaxDiagnostics(await parse('<?php\n$a = 1\n$b = 2;\n'));
    assert.equal(first.code, 'syntax-error');
  });
});

describe('quickFixes', () => {
  it('ajoute « ; » à la fin de la ligne', async () => {
    const diagnostics = await check('<?php\n$a = 1\n$b = 2;\n');
    const [fix] = quickFixes('file:///a.php', diagnostics);
    assert.equal(fix.kind, 'quickfix');
    assert.equal(fix.isPreferred, true);
    assert.deepEqual(fix.diagnostics, diagnostics);
    assert.deepEqual(fix.edit?.changes?.['file:///a.php'], [{ range: { start: { line: 1, character: 6 }, end: { line: 1, character: 6 } }, newText: ';' }]);
  });

  it('rien pour une autre erreur', async () => {
    assert.deepEqual(quickFixes('file:///a.php', await check('<?php\nfunction f( {\n')), []);
  });
});
