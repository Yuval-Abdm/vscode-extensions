import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseStatusV2 } from '../src/git/parsers/status.ts';

describe('parseStatusV2', () => {
  it('branche, avance/retard, conflits, modifications, renommage', () => {
    const text = [
      '# branch.oid 0123',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb a.txt',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt',
      'old name.txt',
      'u UU N... 100644 100644 100644 100644 h1 h2 h3 dir/both mod.txt',
      'u UD N... 100644 100644 000000 100644 h1 h2 h3 gone.txt',
      '',
    ].join('\0');
    assert.deepEqual(parseStatusV2(text), {
      branch: { head: 'main', upstream: 'origin/main', ahead: 2, behind: 1 },
      conflicts: [
        { path: 'dir/both mod.txt', kind: 'both-modified' },
        { path: 'gone.txt', kind: 'deleted-by-them' },
      ],
      changes: 2,
    });
  });

  it('HEAD détaché', () => {
    assert.equal(parseStatusV2('# branch.oid 0123\0# branch.head (detached)\0').branch.head, undefined);
  });
});
