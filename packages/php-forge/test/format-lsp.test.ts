import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_FORMAT, formatOptions, onTypeRange } from '../src/server/format/format.ts';
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
});
