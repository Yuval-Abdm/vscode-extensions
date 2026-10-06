import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import { tagDiagnostics } from '../src/server/diagnostics/tags.ts';
import { quickFixes } from '../src/server/features/codeActions.ts';
import { parse } from './helpers.ts';

const URI = 'file:///a.php';

async function check(code: string): Promise<Diagnostic[]> {
  return tagDiagnostics(await parse(code), code);
}

/** Texte après application de la correction rapide `index`. */
function apply(code: string, diagnostic: Diagnostic, index = 0): string {
  const fix = quickFixes(URI, [diagnostic])[index];
  const lines = code.split('\n');
  const offset = (p: { line: number; character: number }) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  const edits = [...(fix.edit?.changes?.[URI] ?? [])].sort((a, b) => offset(b.range.start) - offset(a.range.start));
  let text = code;
  for (const e of edits) text = text.slice(0, offset(e.range.start)) + e.newText + text.slice(offset(e.range.end));
  return text;
}

describe('valeur non affichée', () => {
  for (const [label, code, fixed, echoed] of [
    ['variable seule en balise courte', '<div><?$nom_conseiller?></div>', '<div><?=$nom_conseiller?></div>', '<div><?php echo $nom_conseiller?></div>'],
    ['variable seule après <?php', '<p><?php $a ?></p>', '<p><?= $a ?></p>', '<p><?php echo $a ?></p>'],
    ['avec « ; »', '<p><?php $a; ?></p>', '<p><?= $a; ?></p>', '<p><?php echo $a; ?></p>'],
    ['élément de tableau', "<i value=\"<?php $c['nom']  ?>\">", "<i value=\"<?= $c['nom']  ?>\">", "<i value=\"<?php echo $c['nom']  ?>\">"],
    ['propriété', '<?php\n$a = 1;\n?>\n<p><?php $o->p ?></p>', '<?php\n$a = 1;\n?>\n<p><?= $o->p ?></p>', '<?php\n$a = 1;\n?>\n<p><?php echo $o->p ?></p>'],
    ['concaténation', "<p><?php $a . ' €' ?></p>", "<p><?= $a . ' €' ?></p>", "<p><?php echo $a . ' €' ?></p>"],
    ['majuscules', '<p><?PHP $a ?></p>', '<p><?= $a ?></p>', '<p><?php echo $a ?></p>'],
  ] as const) {
    it(label, async () => {
      const diagnostics = (await check(code)).filter((d) => d.code === 'useless-output');
      assert.equal(diagnostics.length, 1, JSON.stringify(diagnostics));
      const [d] = diagnostics;
      assert.equal(d.severity, DiagnosticSeverity.Warning);
      assert.match(String(d.message), /<\?=/);
      assert.equal(apply(code, d), fixed);
      assert.equal(apply(code, d, 1), echoed);
      assert.equal(quickFixes(URI, [d])[0].isPreferred, true);
    });
  }

  it('balise courte avec valeur seule : un seul diagnostic', async () => {
    assert.deepEqual((await check('<div><?$a?></div>')).map((d) => d.code), ['useless-output']);
  });

  for (const [label, code] of [
    ['<?= déjà présent', '<p><?= $a ?></p>'],
    ['echo', '<p><?php echo $a ?></p>'],
    ['appel de fonction (peut afficher)', '<p><?php foo() ?></p>'],
    ['affectation', '<p><?php $a = 1 ?></p>'],
    ['plusieurs instructions', '<p><?php $a = 1; $a ?></p>'],
    ['incrément', '<p><?php $i++ ?></p>'],
    ['bloc sans fermeture', '<?php\n$a;\n'],
  ] as const) {
    it(`rien : ${label}`, async () => {
      assert.deepEqual((await check(code)).filter((d) => d.code === 'useless-output'), []);
    });
  }
});

describe('balise courte', () => {
  it('<? suivi de code', async () => {
    const code = '<p><? if ($x) { ?>a<? } ?></p>';
    const diagnostics = await check(code);
    assert.deepEqual(diagnostics.map((d) => [d.code, d.range.start.character, d.range.end.character]), [['short-open-tag', 3, 5], ['short-open-tag', 19, 21]]);
    assert.equal(diagnostics[0].severity, DiagnosticSeverity.Warning);
    assert.equal(apply(code, diagnostics[0]), '<p><?php if ($x) { ?>a<? } ?></p>');
  });

  it('<? collé au code', async () => {
    const code = '<p><?if ($x) { ?>a<?php } ?></p>';
    const [d] = await check(code);
    assert.equal(apply(code, d), '<p><?php if ($x) { ?>a<?php } ?></p>');
  });

  it('fichier commençant par des lignes vides', async () => {
    assert.deepEqual(await check('\r\n\r\n<div><?php echo $a ?></div><p><?= $b ?></p>'), []);
    assert.deepEqual((await check('\r\n\r\n<div><?php $a ?></div>')).map((d) => [d.code, d.range.start.line, d.range.start.character]), [['useless-output', 2, 5]]);
  });

  it('rien pour <?php et <?=', async () => {
    assert.deepEqual(await check('<?php echo 1; ?><p><?= $a ?></p><?php\nfoo();'), []);
  });
});
