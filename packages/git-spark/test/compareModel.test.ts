import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildFileTree, diffSides } from '../src/features/compare/model.ts';

describe('arbre des fichiers', () => {
  it('dossiers d’abord, triés, dossiers à enfant unique fusionnés', () => {
    const tree = buildFileTree([
      { status: 'M', path: 'z.txt' },
      { status: 'A', path: 'src/deep/inner/x.ts' },
      { status: 'M', path: 'src/a.ts' },
      { status: 'D', path: 'lib/one/two.ts' },
    ]);
    const shape = (entries: ReturnType<typeof buildFileTree>): unknown =>
      entries.map((e) => (e.kind === 'folder' ? { [e.name]: shape(e.children) } : e.name));
    assert.deepEqual(shape(tree), [{ 'lib/one': ['two.ts'] }, { src: [{ 'deep/inner': ['x.ts'] }, 'a.ts'] }, 'z.txt']);
    const src = tree[1];
    assert.ok(src.kind === 'folder');
    assert.equal(src.path, 'src');
    const deep = src.children[0];
    assert.ok(deep.kind === 'folder');
    assert.equal(deep.path, 'src/deep/inner');
  });
});

describe('côtés des diffs', () => {
  it('modifié, renommé, ajouté, supprimé ; droite = commit ou arbre de travail', () => {
    assert.deepEqual(diffSides('/r', 'b1', 'r1', { status: 'M', path: 'a.txt' }), {
      left: { root: '/r', path: 'a.txt', sha: 'b1' },
      right: { root: '/r', path: 'a.txt', sha: 'r1' },
    });
    assert.deepEqual(diffSides('/r', 'b1', undefined, { status: 'R', path: 'new.txt', oldPath: 'old.txt' }), {
      left: { root: '/r', path: 'old.txt', sha: 'b1' },
      right: 'worktree',
    });
    assert.deepEqual(diffSides('/r', 'b1', 'r1', { status: 'A', path: 'a.txt' }).left, { root: '/r', path: 'a.txt', sha: '' });
    assert.deepEqual(diffSides('/r', 'b1', undefined, { status: 'D', path: 'a.txt' }).right, { root: '/r', path: 'a.txt', sha: '' });
  });
});
