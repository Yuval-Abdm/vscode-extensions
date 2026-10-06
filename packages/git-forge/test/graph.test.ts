import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GitCommands } from '../src/git/commands.ts';
import { parseDecorations } from '../src/git/parsers/graph.ts';
import { GitRunner } from '../src/git/runner.ts';
import { makeRepo } from './helpers/repo.ts';

const git = new GitCommands(new GitRunner('git'));

describe('décorations', () => {
  it('HEAD, branches, branches distantes, tags', () => {
    assert.deepEqual(parseDecorations('HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main, refs/remotes/origin/HEAD, refs/heads/feat/x'), [
      { name: 'main', kind: 'branch', current: true },
      { name: 'v1', kind: 'tag' },
      { name: 'origin/main', kind: 'remote' },
      { name: 'feat/x', kind: 'branch' },
    ]);
    assert.deepEqual(parseDecorations('HEAD'), [{ name: 'HEAD', kind: 'head' }]);
    assert.deepEqual(parseDecorations(''), []);
  });
});

describe('log du graphe', () => {
  it('ordre topologique, parents, références ; branche courante seulement ; stash exclu', async () => {
    const repo = makeRepo();
    try {
      repo.write('f', '1\n');
      repo.commit('c1');
      repo.write('f', '2\n');
      repo.commit('c2');
      repo.git('switch', '-q', '-c', 'feat');
      repo.write('g', 'x\n');
      repo.commit('feat1');
      repo.git('tag', 'v1');
      repo.git('switch', '-q', 'main');
      repo.write('f', '3\n');
      repo.commit('c3');
      repo.git('merge', '-q', '--no-edit', 'feat');
      repo.git('switch', '-q', '-c', 'side', 'HEAD~1');
      repo.write('s', 's\n');
      repo.commit('side1');
      repo.git('switch', '-q', 'main');
      repo.write('f', 'stash me\n');
      repo.git('stash', 'push', '-q');

      const all = await git.graph(repo.root, { all: true });
      assert.equal(all.length, 6);
      assert.ok(!all.some((c) => /WIP|index on/.test(c.summary)));
      const merge = all.find((c) => c.summary.startsWith('Merge'));
      assert.ok(merge);
      assert.equal(merge.parents.length, 2);
      assert.deepEqual(merge.refs, [{ name: 'main', kind: 'branch', current: true }]);
      assert.deepEqual(all.find((c) => c.summary === 'feat1')?.refs, [{ name: 'v1', kind: 'tag' }, { name: 'feat', kind: 'branch' }]);
      // Ordre topologique : un enfant avant ses parents.
      const index = new Map(all.map((c, i) => [c.sha, i]));
      for (const commit of all) for (const parent of commit.parents) assert.ok((index.get(parent) ?? Infinity) > (index.get(commit.sha) ?? -1));

      const current = await git.graph(repo.root, { all: false });
      assert.ok(!current.some((c) => c.summary === 'side1'));
      assert.deepEqual((await git.graph(repo.root, { all: true, skip: 4, limit: 10 })).length, 2);
    } finally {
      repo.dispose();
    }
  });

  it('créer une branche et un tag sur un commit, checkout détaché', async () => {
    const repo = makeRepo();
    try {
      repo.write('f', '1\n');
      const first = repo.commit('c1');
      repo.write('f', '2\n');
      repo.commit('c2');
      await git.createBranch(repo.root, 'from-first', first);
      await git.createTag(repo.root, 'first-tag', first);
      assert.equal(repo.git('rev-parse', 'from-first').trim(), first);
      assert.equal(repo.git('rev-parse', 'first-tag^{commit}').trim(), first);
      await git.checkoutDetached(repo.root, first);
      assert.equal(repo.git('rev-parse', 'HEAD').trim(), first);
      assert.equal((await git.status(repo.root)).branch.head, undefined);
    } finally {
      repo.dispose();
    }
  });
});
