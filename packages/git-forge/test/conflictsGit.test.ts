import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { GitCommands } from '../src/git/commands.ts';
import { GitRunner } from '../src/git/runner.ts';
import { makeRepo, type TestRepo } from './helpers/repo.ts';

const git = new GitCommands(new GitRunner('git'));

/** main et feature modifient la même ligne de f.txt ; feature supprime aussi d.txt que main modifie. */
function conflicting(): TestRepo {
  const repo = makeRepo();
  repo.write('f.txt', 'base\n');
  repo.write('d.txt', 'keep\n');
  repo.commit('base');
  repo.git('switch', '-q', '-c', 'feature');
  repo.write('f.txt', 'theirs\n');
  repo.git('rm', '-q', 'd.txt');
  repo.commit('feature change');
  repo.git('switch', '-q', 'main');
  repo.write('f.txt', 'ours\n');
  repo.write('d.txt', 'changed\n');
  repo.commit('main change');
  return repo;
}

describe('conflits côté git', () => {
  it("merge en conflit : statut, opération, résultat 'conflicts'", async () => {
    const repo = conflicting();
    try {
      assert.equal(await git.merge(repo.root, 'feature', { noFf: false }), 'conflicts');
      const status = await git.status(repo.root);
      assert.deepEqual(status.conflicts, [
        { path: 'd.txt', kind: 'deleted-by-them' },
        { path: 'f.txt', kind: 'both-modified' },
      ]);
      assert.equal(status.branch.head, 'main');
      const operation = await git.operation(repo.root);
      assert.equal(operation?.kind, 'merge');
      assert.match(operation?.label ?? '', /feature/);
    } finally {
      repo.dispose();
    }
  });

  it('garder le leur, garder le fichier, ajouter, terminer : commit de merge à deux parents', async () => {
    const repo = conflicting();
    try {
      await git.merge(repo.root, 'feature', { noFf: false });
      await git.checkoutSide(repo.root, 'f.txt', 'theirs');
      assert.equal(readFileSync(path.join(repo.root, 'f.txt'), 'utf8'), 'theirs\n');
      await git.add(repo.root, 'f.txt');
      await git.add(repo.root, 'd.txt');
      await git.continueOperation(repo.root, 'merge');
      assert.equal(await git.operation(repo.root), undefined);
      assert.equal(repo.git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').length, 3);
    } finally {
      repo.dispose();
    }
  });

  it('supprimer le fichier puis abandonner : retour à l’état initial', async () => {
    const repo = conflicting();
    try {
      const before = repo.git('rev-parse', 'HEAD').trim();
      await git.merge(repo.root, 'feature', { noFf: false });
      await git.remove(repo.root, 'd.txt');
      assert.equal(existsSync(path.join(repo.root, 'd.txt')), false);
      await git.abortOperation(repo.root, 'merge');
      assert.equal(await git.operation(repo.root), undefined);
      assert.equal(repo.git('rev-parse', 'HEAD').trim(), before);
      assert.equal(readFileSync(path.join(repo.root, 'd.txt'), 'utf8'), 'changed\n');
    } finally {
      repo.dispose();
    }
  });

  it('cherry-pick en conflit, puis continuer', async () => {
    const repo = conflicting();
    try {
      const feature = repo.git('rev-parse', 'feature').trim();
      await assert.rejects(git.runner.write(repo.root, ['cherry-pick', feature]));
      assert.equal((await git.operation(repo.root))?.kind, 'cherry-pick');
      await git.checkoutSide(repo.root, 'f.txt', 'ours');
      await git.add(repo.root, 'f.txt');
      await git.remove(repo.root, 'd.txt');
      await git.continueOperation(repo.root, 'cherry-pick');
      assert.equal(await git.operation(repo.root), undefined);
    } finally {
      repo.dispose();
    }
  });

  it('rebase en conflit : opération rebase, libellé = branche rebasée', async () => {
    const repo = conflicting();
    try {
      repo.git('switch', '-q', 'feature');
      await assert.rejects(git.runner.write(repo.root, ['rebase', 'main']));
      const operation = await git.operation(repo.root);
      assert.deepEqual(operation, { kind: 'rebase', label: 'feature' });
      await git.abortOperation(repo.root, 'rebase');
      assert.equal(await git.operation(repo.root), undefined);
    } finally {
      repo.dispose();
    }
  });

  it('branches locales avec leur branche distante ; ancêtre ; rev-parse', async () => {
    const repo = makeRepo();
    try {
      repo.write('a.txt', 'a\n');
      const base = repo.commit('base');
      repo.git('switch', '-q', '-c', 'feature');
      repo.write('a.txt', 'b\n');
      const next = repo.commit('next');
      repo.git('remote', 'add', 'origin', repo.root);
      repo.git('config', 'branch.feature.remote', 'origin');
      repo.git('config', 'branch.feature.merge', 'refs/heads/feat');
      const branches = await git.branches(repo.root);
      assert.deepEqual(branches.map((b) => b.name), ['feature', 'main']);
      assert.deepEqual(branches[0].upstream, { name: 'origin/feat', remote: 'origin', ref: 'refs/heads/feat' });
      assert.equal(branches[1].upstream, undefined);
      assert.equal(branches[1].sha, base);
      assert.equal(await git.isAncestor(repo.root, base, next), true);
      assert.equal(await git.isAncestor(repo.root, next, base), false);
      assert.equal(await git.revParse(repo.root, 'feature'), next);
      assert.equal(await git.revParse(repo.root, 'feature@{upstream}'), undefined);
      assert.deepEqual(await git.remotes(repo.root), ['origin']);
    } finally {
      repo.dispose();
    }
  });
});
