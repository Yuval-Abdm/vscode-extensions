import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Diagnostic } from 'vscode-languageserver/node';
import { Baseline, BASELINE_PATH, baselineKey } from '../src/server/diagnostics/baseline.ts';

const d = (line: number, code: string, message = code): Diagnostic => ({ range: { start: { line, character: 0 }, end: { line, character: 1 } }, code, message, source: 'PHP Forge' });

describe('baseline', () => {
  const text = '<?php\necho $a;\n  echo $a;\necho $b;\n';

  it('clé : code, message sans les appelants, texte de la ligne sans espaces de bord', () => {
    assert.equal(baselineKey(d(1, 'x', '$a is not defined when included from a.php:2'), 'echo $a;'), baselineKey(d(5, 'x', '$a is not defined when included from b.php:9 (defined in 2 other callers)'), '   echo $a;   '));
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

  it('enregistrement, lecture, suppression', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'php-forge-'));
    Baseline.from([{ rel: 'a.php', diagnostics: [d(1, 'x')], text }]).save(root);
    const file = path.join(root, BASELINE_PATH);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1);
    assert.equal(Baseline.load(root)?.size, 1);
    Baseline.clear(root);
    assert.equal(existsSync(file), false);
    assert.equal(Baseline.load(root), undefined);
  });
});
