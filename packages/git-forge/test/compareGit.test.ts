import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { GitCommands } from '../src/git/commands.ts';
import { parseWorktrees } from '../src/git/parsers/worktree.ts';
import { GitError, GitRunner } from '../src/git/runner.ts';
import { makeRepo, type TestRepo } from './helpers/repo.ts';

const git = new GitCommands(new GitRunner('git'));

/** main : a.txt ; feature (depuis main) : b.txt ajouté, a.txt modifié ; main ensuite : c.txt. */
function branched(): TestRepo {
  const repo = makeRepo();
  repo.write('a.txt', 'a\n');
  repo.commit('base');
  repo.git('switch', '-q', '-c', 'feature');
  repo.write('a.txt', 'a feature\n');
  repo.write('dir/sub/b.txt', 'b\n');
  repo.commit('feature work');
  repo.git('switch', '-q', 'main');
  repo.write('c.txt', 'c\n');
  repo.commit('main work');
  repo.git('tag', 'v1');
  return repo;
}

describe('comparaison', () => {
  it('références : branches, tags (sans refs/remotes/*/HEAD)', async () => {
    const repo = branched();
    try {
      const refs = await git.refs(repo.root);
      assert.deepEqual(refs.map((r) => `${r.kind}:${r.name}:${r.ref}`), ['branch:feature:refs/heads/feature', 'branch:main:refs/heads/main', 'tag:v1:refs/tags/v1']);
      assert.equal(refs[1].sha, repo.git('rev-parse', 'main').trim());
    } finally {
      repo.dispose();
    }
  });

  it("depuis l'ancêtre commun ou directement", async () => {
    const repo = branched();
    try {
      const fromBase = await git.compareFiles(repo.root, 'main', 'feature', 'merge-base');
      assert.deepEqual(fromBase.changes, [{ status: 'M', path: 'a.txt' }, { status: 'A', path: 'dir/sub/b.txt' }]);
      assert.equal(fromBase.base, repo.git('merge-base', 'main', 'feature').trim());
      const direct = await git.compareFiles(repo.root, 'main', 'feature', 'direct');
      assert.deepEqual(direct.changes, [{ status: 'M', path: 'a.txt' }, { status: 'D', path: 'c.txt' }, { status: 'A', path: 'dir/sub/b.txt' }]);
      assert.equal(direct.base, repo.git('rev-parse', 'main').trim());
      assert.deepEqual((await git.commitsBetween(repo.root, 'main', 'feature')).map((e) => e.summary), ['feature work']);
    } finally {
      repo.dispose();
    }
  });

  it("avec l'arbre de travail : modifications non commitées comprises", async () => {
    const repo = branched();
    try {
      repo.write('c.txt', 'changed\n');
      const result = await git.compareFiles(repo.root, 'v1', undefined, 'direct');
      assert.deepEqual(result.changes, [{ status: 'M', path: 'c.txt' }]);
      assert.deepEqual(await git.commitsBetween(repo.root, 'v1', undefined), []);
    } finally {
      repo.dispose();
    }
  });

  it('historiques sans ancêtre commun : comparaison directe', async () => {
    const repo = branched();
    try {
      repo.git('switch', '-q', '--orphan', 'other');
      repo.write('z.txt', 'z\n');
      repo.commit('orphan');
      const result = await git.compareFiles(repo.root, 'main', 'other', 'merge-base');
      assert.equal(result.base, repo.git('rev-parse', 'main').trim());
      assert.ok(result.changes.some((c) => c.path === 'z.txt' && c.status === 'A'));
    } finally {
      repo.dispose();
    }
  });
});

describe('stash', () => {
  it('créer avec les fichiers non suivis, lister, fichiers, appliquer, supprimer', async () => {
    const repo = branched();
    try {
      repo.write('a.txt', 'stashed\n');
      repo.write('new.txt', 'untracked\n');
      await git.stashPush(repo.root, 'my work', true);
      assert.equal(existsSync(path.join(repo.root, 'new.txt')), false);
      const [stash] = await git.stashes(repo.root);
      assert.equal(stash.ref, 'stash@{0}');
      assert.match(stash.message, /my work/);
      assert.ok(stash.time > 0);
      assert.deepEqual(await git.stashFiles(repo.root, stash), [
        { change: { status: 'M', path: 'a.txt' }, untracked: false },
        { change: { status: 'A', path: 'new.txt' }, untracked: true },
      ]);
      assert.equal(await git.stashApply(repo.root, stash, false), 'applied');
      assert.equal(readFileSync(path.join(repo.root, 'new.txt'), 'utf8'), 'untracked\n');
      assert.equal((await git.stashes(repo.root)).length, 1);
      await git.stashDrop(repo.root, stash);
      assert.deepEqual(await git.stashes(repo.root), []);
    } finally {
      repo.dispose();
    }
  });

  it('pop en conflit : « conflicts », stash gardé', async () => {
    const repo = branched();
    try {
      repo.write('a.txt', 'stashed\n');
      await git.stashPush(repo.root, 'conflicting');
      repo.write('a.txt', 'committed meanwhile\n');
      repo.commit('meanwhile');
      assert.equal(await git.stashApply(repo.root, (await git.stashes(repo.root))[0], true), 'conflicts');
      assert.equal((await git.status(repo.root)).conflicts.length, 1);
      assert.equal((await git.stashes(repo.root)).length, 1);
    } finally {
      repo.dispose();
    }
  });
});

describe('worktrees', () => {
  it('ajouter (branche existante et nouvelle), lister, supprimer (refus si modifié)', async () => {
    const repo = branched();
    const base = realpathSync(tmpdir());
    const existing = path.join(base, `gf-wt-${process.pid}-a`);
    const created = path.join(base, `gf-wt-${process.pid}-b`);
    try {
      await git.worktreeAdd(repo.root, existing, 'feature', false);
      await git.worktreeAdd(repo.root, created, 'topic', true);
      const list = await git.worktrees(repo.root);
      assert.deepEqual(list.map((w) => [path.basename(w.path), w.branch]), [
        [path.basename(realpathSync(repo.root)), 'main'],
        [path.basename(existing), 'feature'],
        [path.basename(created), 'topic'],
      ]);
      assert.equal(list[0].detached, false);
      await import('node:fs').then((fs) => fs.writeFileSync(path.join(existing, 'a.txt'), 'dirty\n'));
      await assert.rejects(git.worktreeRemove(repo.root, existing, false), GitError);
      await git.worktreeRemove(repo.root, existing, true);
      await git.worktreeRemove(repo.root, created, false);
      await git.worktreeAdd(repo.root, existing, 'feature', false);
      repo.git('worktree', 'lock', existing);
      await assert.rejects(git.worktreeRemove(repo.root, existing, true), GitError);
      await git.worktreeRemove(repo.root, existing, true, true);
      assert.equal((await git.worktrees(repo.root)).length, 1);
    } finally {
      repo.dispose();
    }
  });

  it('format porcelain : détaché, verrouillé, nu', () => {
    const text = 'worktree /r\nbare\n\nworktree /w\nHEAD abc\ndetached\nlocked reason\nprunable gone\n\n';
    assert.deepEqual(parseWorktrees(text), [
      { path: '/r', detached: false, bare: true, locked: false, prunable: false },
      { path: '/w', head: 'abc', detached: true, bare: false, locked: true, prunable: true },
    ]);
  });
});

describe('cas limites (revue 0.4)', () => {
  it('stash de modifications seulement indexées : listées, restaurées par pop (--index)', async () => {
    const repo = branched();
    try {
      repo.write('a.txt', 'staged\n');
      repo.git('add', 'a.txt');
      repo.write('a.txt', 'a\n');
      await git.stashPush(repo.root, 'index only');
      const [stash] = await git.stashes(repo.root);
      assert.deepEqual((await git.stashFiles(repo.root, stash)).map((f) => f.change.path), ['a.txt']);
      assert.equal(await git.stashApply(repo.root, stash, true), 'applied');
      assert.equal(repo.git('show', ':a.txt'), 'staged\n');
    } finally {
      repo.dispose();
    }
  });

  it('stash désigné par son SHA : un nouveau stash ne décale pas la cible', async () => {
    const repo = branched();
    try {
      repo.write('a.txt', 'one\n');
      await git.stashPush(repo.root, 'first');
      const [first] = await git.stashes(repo.root);
      repo.write('a.txt', 'two\n');
      await git.stashPush(repo.root, 'second'); // first devient stash@{1}
      await git.stashDrop(repo.root, first);
      const left = await git.stashes(repo.root);
      assert.equal(left.length, 1);
      assert.match(left[0].message, /second/);
      await assert.rejects(git.stashDrop(repo.root, first), /no longer exists/);
    } finally {
      repo.dispose();
    }
  });

  it('référence du même nom qu’un fichier ; fichiers non suivis avec l’arbre de travail', async () => {
    const repo = branched();
    try {
      repo.write('main', 'a file named like the branch\n');
      repo.commit('file main');
      repo.write('brandnew.php', '<?php\n');
      const direct = await git.compareFiles(repo.root, 'v1', 'feature', 'direct');
      assert.ok(direct.changes.some((c) => c.path === 'dir/sub/b.txt'));
      const worktree = await git.compareFiles(repo.root, 'main', undefined, 'direct');
      assert.deepEqual(worktree.changes, [{ status: 'A', path: 'brandnew.php' }]);
    } finally {
      repo.dispose();
    }
  });
});
