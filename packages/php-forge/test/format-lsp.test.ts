import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_FORMAT, formatEdits, formatOptions, onTypeRange, onTypeWindow } from '../src/server/format/format.ts';
import { parse } from './helpers.ts';

describe('formateur dans l’éditeur', () => {
  it('indentation de l’éditeur', () => {
    const settings = { enable: true, braces: 'psr12' as const, alignArrows: false, alignAssignments: false, trailingCommas: false, lineLength: 120 };
    assert.deepEqual(formatOptions(settings, { tabSize: 2, insertSpaces: true }), { ...DEFAULT_FORMAT, unit: '  ' });
    assert.equal(formatOptions(settings, { tabSize: 4, insertSpaces: false }).unit, '\t');
  });

  it('frappe de ; : la ligne ; de } : le bloc fermé', async () => {
    const code = '<?php\nif ($a) {\nfoo();\n}\n';
    const tree = await parse(code);
    assert.deepEqual(onTypeRange(tree, { line: 2, character: 6 }, ';'), { start: { line: 2, character: 0 }, end: { line: 2, character: 6 } });
    assert.deepEqual(onTypeRange(tree, { line: 3, character: 1 }, '}'), { start: { line: 1, character: 0 }, end: { line: 3, character: 1 } });
  });

  it('frappe dans un gros fichier : seule l’instruction est mise en page, mêmes modifications', async () => {
    const methods = Array.from({ length: 4000 }, (_, i) => `    public function m${i}($a)\n    {\n        return $a + ${i};\n    }\n`).join('\n');
    const code = `<?php\nclass Big\n{\n${methods}}\n`.replace('return $a + 2000;', 'return $a+2000 ;');
    const tree = await parse(code);
    const line = code.split('\n').findIndex((l) => l.includes('$a+2000'));
    const range = { start: { line, character: 0 }, end: { line, character: 30 } };
    let started = performance.now();
    const full = formatEdits(tree, code, DEFAULT_FORMAT, range);
    const fullMs = performance.now() - started;
    started = performance.now();
    const window = onTypeWindow(tree, range)!;
    const partial = formatEdits(tree, code, DEFAULT_FORMAT, range, window);
    const partialMs = performance.now() - started;
    assert.equal(window.type, 'return_statement');
    assert.deepEqual(partial, full);
    assert.ok(full.length > 0);
    assert.ok(partialMs * 5 < fullMs, `${partialMs.toFixed(1)} ms contre ${fullMs.toFixed(1)} ms`);
  });
});
