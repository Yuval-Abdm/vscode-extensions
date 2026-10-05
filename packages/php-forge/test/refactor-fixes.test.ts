import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Diagnostic } from 'vscode-languageserver/node';
import { applyReplacement, diagnosticFixes } from '../src/server/refactor/fixes.ts';
import { parse } from './helpers.ts';

const URI = 'file:///p/a.php';
const diag = (line: number, start: number, end: number, code: string, data: unknown): Diagnostic => ({ range: { start: { line, character: start }, end: { line, character: end } }, code, message: code, data, source: 'PHP Forge' });

async function fixes(text: string, d: Diagnostic) {
  return diagnosticFixes(URI, text, await parse(text), [d]);
}

describe('déclarer la variable', () => {
  it('ligne au-dessus de l’instruction, même indentation', async () => {
    const text = '<?php\nfunction f()\n{\n    if (true) {\n        echo $total;\n    }\n}\n';
    const [fix] = await fixes(text, diag(4, 13, 19, 'undefined-variable', { variable: 'total' }));
    assert.equal(fix.title, 'Declare $total');
    assert.deepEqual(fix.edit?.changes?.[URI], [{ range: { start: { line: 4, character: 0 }, end: { line: 4, character: 0 } }, newText: '        $total = null;\n' }]);
  });

  it('instruction qui ne commence pas sa ligne (HTML) : pas de correction', async () => {
    const text = '<p><?= $nom ?></p>\n';
    assert.deepEqual(await fixes(text, diag(0, 7, 11, 'undefined-variable', { variable: 'nom' })), []);
  });
});

describe('remplacer une API', () => {
  it('modèles des stubs', () => {
    assert.equal(applyReplacement('nl2br(hebrev(%parameter0%))', ['$t']), 'nl2br(hebrev($t))');
    assert.equal(applyReplacement('mysql_num_rows(%parametersList%)', ['$r', '1']), 'mysql_num_rows($r, 1)');
    assert.equal(applyReplacement('oci_free_statement', ['$s']), 'oci_free_statement($s)');
    assert.equal(applyReplacement('enchant_dict_add(%parameter0%, %parameter1%)', ['$d']), undefined);
    assert.equal(applyReplacement('%class%->getReadTimout(%parameter0%)', ['$x']), undefined);
    assert.equal(applyReplacement('Use mysqli_set_charset instead', []), undefined);
  });

  it('appel remplacé en entier', async () => {
    const text = "<?php\necho hebrevc($texte, 70);\n";
    const [fix] = await fixes(text, diag(1, 5, 12, 'deprecated-api', { replacement: 'nl2br(hebrev(%parameter0%))' }));
    assert.equal(fix.title, 'Replace with nl2br(hebrev($texte))');
    assert.deepEqual(fix.edit?.changes?.[URI], [{ range: { start: { line: 1, character: 5 }, end: { line: 1, character: 24 } }, newText: 'nl2br(hebrev($texte))' }]);
  });
});
