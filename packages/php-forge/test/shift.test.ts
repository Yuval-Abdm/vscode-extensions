import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Diagnostic } from 'vscode-languageserver/node';
import { shiftDiagnostics } from '../src/server/diagnostics/shift.ts';

const d = (line: number, start: number, end: number): Diagnostic => ({ range: { start: { line, character: start }, end: { line, character: end } }, message: 'x' });
const at = (line: number, character: number) => ({ line, character });
const lines = (list: Diagnostic[]) => list.map((x) => `${x.range.start.line}:${x.range.start.character}-${x.range.end.character}`);

describe('diagnostics déplacés par les modifications', () => {
  it('lignes ajoutées ou supprimées au-dessus', () => {
    assert.deepEqual(lines(shiftDiagnostics([d(5, 2, 4)], [{ range: { start: at(1, 0), end: at(1, 0) }, text: 'a\nb\n' }])), ['7:2-4']);
    assert.deepEqual(lines(shiftDiagnostics([d(5, 2, 4)], [{ range: { start: at(1, 0), end: at(3, 0) }, text: '' }])), ['3:2-4']);
  });

  it('texte inséré avant sur la même ligne : colonnes décalées', () => {
    assert.deepEqual(lines(shiftDiagnostics([d(2, 10, 14)], [{ range: { start: at(2, 3), end: at(2, 3) }, text: 'abc' }])), ['2:13-17']);
  });

  it('modification après ou sur le diagnostic', () => {
    assert.deepEqual(lines(shiftDiagnostics([d(2, 1, 3)], [{ range: { start: at(2, 5), end: at(2, 5) }, text: 'x' }])), ['2:1-3']);
    assert.deepEqual(shiftDiagnostics([d(2, 1, 3)], [{ range: { start: at(2, 2), end: at(2, 2) }, text: 'x' }]), []);
    assert.deepEqual(shiftDiagnostics([d(2, 1, 3)], [{ text: 'tout' }]), []);
  });

  it('plusieurs modifications à la suite', () => {
    const changes = [{ range: { start: at(0, 0), end: at(0, 0) }, text: '\n' }, { range: { start: at(0, 0), end: at(0, 0) }, text: '\n' }];
    assert.deepEqual(lines(shiftDiagnostics([d(1, 0, 1)], changes)), ['3:0-1']);
  });
});
