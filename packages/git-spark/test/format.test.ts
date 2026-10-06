import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ageBucket, blameBlocks, DEFAULT_FORMAT, formatBlame, truncate } from '../src/features/blame/format.ts';

const values = { author: 'Alice', date: '3 days ago', message: 'Fix bug', sha: '0123456789abcdef' };

describe('formatBlame', () => {
  it('gabarit par défaut', () => {
    assert.equal(formatBlame(DEFAULT_FORMAT, values), 'Alice, 3 days ago • Fix bug');
  });

  it('SHA court et variables inconnues laissées telles quelles', () => {
    assert.equal(formatBlame('${sha} ${author} ${other}', values), '0123456 Alice ${other}');
  });
});

describe('truncate', () => {
  it('coupe avec une ellipse', () => {
    assert.equal(truncate('abcdef', 4), 'abc…');
    assert.equal(truncate('abcd', 4), 'abcd');
  });
});

describe('ageBucket', () => {
  const now = 1_000_000_000;
  const day = 86400;
  it('tranches : semaine, mois, six mois, un an, plus', () => {
    assert.equal(ageBucket(now - 2 * day, now), 0);
    assert.equal(ageBucket(now - 10 * day, now), 1);
    assert.equal(ageBucket(now - 100 * day, now), 2);
    assert.equal(ageBucket(now - 300 * day, now), 3);
    assert.equal(ageBucket(now - 400 * day, now), 4);
  });
});

describe('blameBlocks', () => {
  it('regroupe les lignes consécutives du même commit', () => {
    const lines = ['a', 'a', 'b', 'a', 'a'];
    assert.deepEqual(blameBlocks({ commits: new Map(), lines }), [
      { start: 0, end: 1, sha: 'a' },
      { start: 2, end: 2, sha: 'b' },
      { start: 3, end: 4, sha: 'a' },
    ]);
  });
});
