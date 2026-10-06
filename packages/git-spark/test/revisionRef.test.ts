import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeRevision, encodeRevision } from '../src/shared/revisionRef.ts';

describe('RevisionRef', () => {
  it('aller-retour', () => {
    const ref = { root: '/repo', path: 'dossier é/a b.txt', sha: 'abc' };
    assert.deepEqual(decodeRevision(encodeRevision(ref)), ref);
  });

  it('query invalide : undefined', () => {
    assert.equal(decodeRevision('not json'), undefined);
    assert.equal(decodeRevision('{"root":1}'), undefined);
  });
});
