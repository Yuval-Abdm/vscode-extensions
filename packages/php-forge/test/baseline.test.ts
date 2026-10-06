import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Diagnostic } from 'vscode-languageserver/node';
import { Baseline, BASELINE_PATH, baselineKey } from '../src/server/diagnostics/baseline.ts';

const d = (line: number, code: string, message = code): Diagnostic => ({ range: { start: { line, character: 0 }, end: { line, character: 1 } }, code, message, source: 'PHP Forge' });

describe('baseline', () => {
  const text = '<?php\necho $a;\n  echo $a;\necho $b;\n';

  it('clé : code, texte signalé, texte de la ligne sans espaces de bord', () => {
    const indented: Diagnostic = { ...d(5, 'x', '$a is not defined when included from b.php:9 (defined in 2 other callers)'), range: { start: { line: 5, character: 3 }, end: { line: 5, character: 4 } } };
    assert.equal(baselineKey(d(1, 'x', '$a is not defined when included from a.php:2'), 'echo $a;'), baselineKey(indented, '   echo $a;   '));
    assert.notEqual(baselineKey(d(1, 'x'), 'echo $a;'), baselineKey(d(1, 'y'), 'echo $a;'));
  });

  it('masque les alertes existantes (en nombre), garde les nouvelles, robuste aux décalages de lignes', () => {
    const baseline = Baseline.from([{ rel: 'a.php', diagnostics: [d(1, 'undefined-variable', '$a is not defined')], text }]);
    const moved = '<?php\n\n\necho $a;\necho $a;\necho $b;\n';
    const { kept, hidden } = baseline.filter('a.php', [d(3, 'undefined-variable', '$a is not defined'), d(4, 'undefined-variable', '$a is not defined'), d(5, 'undefined-variable', '$b is not defined')], moved);
    assert.equal(hidden, 1);
    assert.deepEqual(kept.map((x) => x.range.start.line), [4, 5]);
    assert.deepEqual(baseline.filter('other.php', [d(1, 'x')], text).hidden, 0);
  });

  it('clé indépendante de la langue du message et des appelants (équipe en anglais et en français)', () => {
    const range = { start: { line: 1, character: 5 }, end: { line: 1, character: 7 } };
    const en: Diagnostic = { range, code: 'undefined-variable', message: '$a is not defined when included from a.php:2' };
    const fr: Diagnostic = { range, code: 'undefined-variable', message: "$a n'est pas définie quand le fichier est inclus depuis b.php:9 (définie dans 2 autres appelants)" };
    assert.equal(baselineKey(en, 'echo $a;'), baselineKey(fr, 'echo $a;'));
    assert.notEqual(baselineKey(en, 'echo $a . $b;'), baselineKey({ ...en, range: { start: { line: 1, character: 10 }, end: { line: 1, character: 12 } } }, 'echo $a . $b;'));
  });

  it('baseline version 1 (clé du message anglais) : toujours appliquée', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'php-forge-'));
    const fnv = (t: string) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193) >>> 0;
      return h.toString(16).padStart(8, '0');
    };
    mkdirSync(path.join(root, '.vscode'));
    writeFileSync(path.join(root, BASELINE_PATH), JSON.stringify({ version: 1, files: { 'a.php': [`undefined-variable|${fnv('$a is not defined')}|${fnv('echo $a;')}`] } }));
    const { hidden } = Baseline.load(root)!.filter('a.php', [d(1, 'undefined-variable', '$a is not defined when included from x.php:3')], text);
    assert.equal(hidden, 1);
  });

  it('enregistrement, lecture, suppression', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'php-forge-'));
    Baseline.from([{ rel: 'a.php', diagnostics: [d(1, 'x')], text }]).save(root);
    const file = path.join(root, BASELINE_PATH);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 2);
    assert.equal(Baseline.load(root)?.size, 1);
    Baseline.clear(root);
    assert.equal(existsSync(file), false);
    assert.equal(Baseline.load(root), undefined);
  });
});
