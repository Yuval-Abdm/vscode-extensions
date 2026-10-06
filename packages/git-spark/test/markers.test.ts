import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findConflicts, hasConflictMarkers, resolveBlock } from '../src/features/conflicts/markers.ts';

const text = [
  'top',
  '<<<<<<< HEAD',
  'ours 1',
  'ours 2',
  '=======',
  'theirs',
  '>>>>>>> feature',
  'middle',
  '<<<<<<< HEAD',
  'mine',
  '||||||| base',
  'original',
  '=======',
  'yours',
  '>>>>>>> other',
].join('\n');
const lines = text.split('\n');

describe('marqueurs de conflit', () => {
  it('blocs, style diff3 compris', () => {
    assert.deepEqual(findConflicts(lines), [
      { start: 1, separator: 4, base: undefined, end: 6, oursLabel: 'HEAD', theirsLabel: 'feature' },
      { start: 8, separator: 12, base: 10, end: 14, oursLabel: 'HEAD', theirsLabel: 'other' },
    ]);
  });

  it('résolution : le mien, le leur, les deux (sans la base diff3)', () => {
    const [first, second] = findConflicts(lines);
    assert.deepEqual(resolveBlock(lines, first, 'ours'), ['ours 1', 'ours 2']);
    assert.deepEqual(resolveBlock(lines, first, 'theirs'), ['theirs']);
    assert.deepEqual(resolveBlock(lines, first, 'both'), ['ours 1', 'ours 2', 'theirs']);
    assert.deepEqual(resolveBlock(lines, second, 'ours'), ['mine']);
  });

  it('marqueur incomplet ou ligne qui ressemble à un marqueur : pas de bloc', () => {
    assert.deepEqual(findConflicts(['<<<<<<< HEAD', 'x', '=======']), []);
    assert.deepEqual(findConflicts(['<<<<<<<x not a marker', '=======', '>>>>>>> x']), []);
    assert.equal(findConflicts(['<<<<<<<<<< HEAD', 'a', '==========', 'b', '>>>>>>>>>> x']).length, 1);
    assert.equal(hasConflictMarkers('a\n<<<<<<< HEAD\nb\n'), true);
    assert.equal(hasConflictMarkers('a\r\n<<<<<<< HEAD\r\nb\r\n=======\r\nc\r\n>>>>>>> x\r\n'), true);
    assert.equal(hasConflictMarkers('a\nb\n'), false);
  });
});
