import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import { applyPolicy, findComposerDirs, ignoreFixes, isLibrary } from '../src/server/diagnostics/policy.ts';
import { quickFixes } from '../src/server/features/codeActions.ts';

const d = (line: number, code: string, severity: DiagnosticSeverity = DiagnosticSeverity.Warning): Diagnostic => ({
  range: { start: { line, character: 0 }, end: { line, character: 1 } }, code, severity, message: code, source: 'PHP Forge',
});

describe('dossiers librairie', () => {
  it('motifs et dossiers Composer tiers', () => {
    const patterns = ['**/vendor/**', '**/PHPExcel/**'];
    assert.equal(isLibrary('/p/vendor/acme/a.php', ['/p'], patterns, []), true);
    assert.equal(isLibrary('/p/lib/PHPExcel/Cell.php', ['/p'], patterns, []), true);
    assert.equal(isLibrary('/p/includes/x.php', ['/p'], patterns, []), false);
    assert.equal(isLibrary('/p/includes/library/aws/S3.php', ['/p'], patterns, ['/p/includes/library/aws']), true);
  });

  it('recherche des composer.json hors racine', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'php-forge-'));
    writeFileSync(path.join(root, 'composer.json'), '{}');
    mkdirSync(path.join(root, 'lib/aws'), { recursive: true });
    writeFileSync(path.join(root, 'lib/aws/composer.json'), '{}');
    assert.deepEqual(await findComposerDirs(root), [path.join(root, 'lib/aws')]);
  });
});

describe('suppressions et niveaux', () => {
  const text = [
    '<?php',
    'echo $a; // @php-forge-ignore undefined-variable',
    '// @php-forge-ignore',
    'echo $b;',
    'echo $c; // @php-forge-ignore other-code',
    'echo $d;',
  ].join('\n');

  it('commentaire sur la ligne ou la ligne précédente, avec ou sans code', () => {
    const kept = applyPolicy([d(1, 'undefined-variable'), d(3, 'undefined-variable'), d(4, 'undefined-variable'), d(5, 'undefined-variable')], text, {});
    assert.deepEqual(kept.map((x) => x.range.start.line), [4, 5]);
  });

  it('suppression pour tout le fichier', () => {
    const file = '<?php\n/** @php-forge-ignore-file unused-use, undefined-variable */\nuse A\\B;\n';
    assert.deepEqual(applyPolicy([d(2, 'unused-use'), d(2, 'undefined-function')], file, {}).map((x) => x.code), ['undefined-function']);
  });

  it('niveau par règle, règle désactivée', () => {
    const out = applyPolicy([d(5, 'undefined-variable'), d(5, 'unused-use'), d(5, 'syntax-error', DiagnosticSeverity.Error)], text, { 'undefined-variable': 'error', 'unused-use': 'off' });
    assert.deepEqual(out.map((x) => [x.code, x.severity]), [['undefined-variable', DiagnosticSeverity.Error], ['syntax-error', DiagnosticSeverity.Error]]);
  });
});

describe('corrections « ignorer »', () => {
  it('ligne PHP : commentaire au-dessus avec la même indentation', () => {
    const text = '<?php\nif ($x) {\n    echo $y;\n}\n';
    const [line, file] = ignoreFixes(d(2, 'undefined-variable'), text);
    assert.deepEqual(line.edits, [{ range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } }, newText: '    // @php-forge-ignore undefined-variable\n' }]);
    assert.equal(line.title, 'Ignore undefined-variable on this line');
    assert.deepEqual(file.edits, [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, newText: '/** @php-forge-ignore-file undefined-variable */\n' }]);
  });

  it('ligne HTML : balise PHP autour du commentaire', () => {
    const text = '<?php $t = 1; ?>\n<div>\n  <p><?= $missing ?></p>\n</div>\n';
    const [line, file] = ignoreFixes(d(2, 'undefined-variable'), text);
    assert.equal(line.edits[0].newText, '  <?php // @php-forge-ignore undefined-variable ?>\n');
    assert.deepEqual(file.edits[0], { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '<?php /** @php-forge-ignore-file undefined-variable */ ?>\n' });
  });

  it('proposées par les actions de code quand le texte est connu', () => {
    const titles = quickFixes('file:///a.php', [d(1, 'undefined-variable')], '<?php\necho $x;\n').map((a) => a.title);
    assert.deepEqual(titles, ['Ignore undefined-variable on this line', 'Ignore undefined-variable in this file']);
    assert.deepEqual(quickFixes('file:///a.php', [d(1, 'undefined-variable')]), []);
  });
});
