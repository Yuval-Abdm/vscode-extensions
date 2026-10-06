import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changeDiffArgs, entryDiffArgs } from '../src/features/history/model.ts';
import type { LogEntry } from '../src/git/parsers/log.ts';

const entry = (files: LogEntry['files'], parents = ['p1']): LogEntry => ({
  sha: 's1', parents, author: 'A', authorMail: 'a@x', authorTime: 0, summary: 'm', files,
});

describe('arguments de diff', () => {
  it('modification : parent → commit, même chemin', () => {
    assert.deepEqual(entryDiffArgs('/r', entry([{ status: 'M', path: 'a.txt' }]), 'a.txt'), {
      root: '/r', sha: 's1', path: 'a.txt', previousSha: 'p1', previousPath: 'a.txt',
    });
  });

  it("renommage : ancien chemin à gauche", () => {
    assert.deepEqual(entryDiffArgs('/r', entry([{ status: 'R', path: 'b.txt', oldPath: 'a.txt' }]), 'b.txt'), {
      root: '/r', sha: 's1', path: 'b.txt', previousSha: 'p1', previousPath: 'a.txt',
    });
  });

  it('ajout ou commit racine : gauche vide', () => {
    assert.deepEqual(entryDiffArgs('/r', entry([{ status: 'A', path: 'a.txt' }]), 'a.txt'), { root: '/r', sha: 's1', path: 'a.txt' });
    assert.deepEqual(entryDiffArgs('/r', entry([{ status: 'M', path: 'a.txt' }], []), 'a.txt'), { root: '/r', sha: 's1', path: 'a.txt' });
  });

  it('suppression : droite vide', () => {
    assert.deepEqual(changeDiffArgs('/r', 's1', 'p1', { status: 'D', path: 'a.txt' }), {
      root: '/r', sha: 's1', path: 'a.txt', previousSha: 'p1', previousPath: 'a.txt', deleted: true,
    });
  });

  it('merge sans fichier listé : chemin suivi, premier parent', () => {
    assert.deepEqual(entryDiffArgs('/r', entry([], ['p1', 'p2']), 'a.txt'), {
      root: '/r', sha: 's1', path: 'a.txt', previousSha: 'p1', previousPath: 'a.txt',
    });
  });
});
