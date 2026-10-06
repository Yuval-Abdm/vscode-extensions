import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { itemsFromCommits, RebaseChangedError, runInteractiveRebase } from '../src/features/operations/rebaseRun.ts';
import { GitCommands } from '../src/git/commands.ts';
import { GitRunner } from '../src/git/runner.ts';
import { makeRepo, type TestRepo } from './helpers/repo.ts';

const git = new GitCommands(new GitRunner('git'));

function fourCommits(): { repo: TestRepo; base: string } {
  const repo = makeRepo();
  repo.write('base', 'b\n');
  const base = repo.commit('base');
  for (const n of [1, 2, 3, 4]) {
    repo.write(`f${n}`, `${n}\n`);
    repo.commit(`c${n}`);
  }
  return { repo, base };
}

const subjects = (repo: TestRepo) => repo.git('log', '--format=%s').trim().split('\n');

describe('rebase interactif', () => {
  it('réordonner, reformuler, squash, fixup, supprimer — avec des modifications non commitées', async () => {
    const { repo, base } = fourCommits();
    try {
      repo.write('base', 'dirty\n');
      const items = itemsFromCommits(await git.commitsForRebase(repo.root, base));
      const [c1, c2, c3, c4] = items;
      const result = await runInteractiveRebase(git, repo.root, base, [
        { ...c2, action: 'reword', newMessage: 'c2 reworded' },
        { ...c1, action: 'pick' },
        { ...c3, action: 'squash', newMessage: 'c1 + c3' },
        { ...c4, action: 'drop' },
      ]);
      assert.equal(result, 'done');
      assert.deepEqual(subjects(repo), ['c1 + c3', 'c2 reworded', 'base']);
      assert.equal(readFileSync(path.join(repo.root, 'base'), 'utf8'), 'dirty\n');
      assert.equal(repo.git('ls-files', 'f4').trim(), '');
    } finally {
      repo.dispose();
    }
  });

  it('edit : arrêt (rebase en cours), puis continuer applique les tâches suivantes', async () => {
    const { repo, base } = fourCommits();
    try {
      const [c1, c2, c3, c4] = itemsFromCommits(await git.commitsForRebase(repo.root, base));
      const result = await runInteractiveRebase(git, repo.root, base, [
        { ...c1, action: 'edit' },
        { ...c2, action: 'reword', newMessage: 'after stop' },
        { ...c3, action: 'fixup' },
        c4,
      ]);
      assert.equal(result, 'stopped');
      assert.equal((await git.operation(repo.root))?.kind, 'rebase');
      await git.continueOperation(repo.root, 'rebase');
      assert.equal(await git.operation(repo.root), undefined);
      assert.deepEqual(subjects(repo), ['c4', 'after stop', 'c1', 'base']);
    } finally {
      repo.dispose();
    }
  });

  it('liste invalide : erreur avant de lancer git', async () => {
    const { repo, base } = fourCommits();
    try {
      const items = itemsFromCommits(await git.commitsForRebase(repo.root, base)).map((item) => ({ ...item, action: 'drop' as const }));
      await assert.rejects(runInteractiveRebase(git, repo.root, base, items), /empty/);
      assert.equal(subjects(repo).length, 5);
    } finally {
      repo.dispose();
    }
  });

  it('commit passé (skip) après un conflit : son nouveau message n’est appliqué à aucun autre commit', async () => {
    const repo = makeRepo();
    try {
      repo.write('f', '0\n');
      const base = repo.commit('base');
      repo.write('f', '1\n');
      repo.commit('A');
      repo.write('f', '2\n');
      repo.commit('B');
      const [a, b] = itemsFromCommits(await git.commitsForRebase(repo.root, base));
      // B d'abord : il entre en conflit sur la base ; on le passe.
      assert.equal(await runInteractiveRebase(git, repo.root, base, [{ ...b, action: 'reword', newMessage: 'B reworded' }, a]), 'stopped');
      await git.skipOperation(repo.root, 'rebase');
      assert.equal(await git.operation(repo.root), undefined);
      assert.deepEqual(subjects(repo), ['A', 'base']);
    } finally {
      repo.dispose();
    }
  });

  it('HEAD ou branche changés depuis l’ouverture de l’éditeur : refus, rien de modifié', async () => {
    const { repo, base } = fourCommits();
    try {
      const head = repo.git('rev-parse', 'HEAD').trim();
      const items = itemsFromCommits(await git.commitsForRebase(repo.root, base));
      repo.write('late', 'x\n');
      repo.commit('late commit');
      await assert.rejects(runInteractiveRebase(git, repo.root, base, items, { head, branch: 'main' }), RebaseChangedError);
      assert.equal(subjects(repo)[0], 'late commit');
    } finally {
      repo.dispose();
    }
  });

  it('modifications mises de côté en conflit à la fin : signalé', async () => {
    const repo = makeRepo();
    try {
      repo.write('f', '0\n');
      const base = repo.commit('base');
      repo.write('f', '1\n');
      repo.commit('A');
      repo.write('g', 'g\n');
      repo.commit('B');
      repo.write('f', '1 then dirty\n');
      const [a, b] = itemsFromCommits(await git.commitsForRebase(repo.root, base));
      assert.equal(await runInteractiveRebase(git, repo.root, base, [{ ...a, action: 'drop' }, b]), 'autostash-conflicts');
      assert.deepEqual(subjects(repo), ['B', 'base']);
      assert.ok(repo.git('stash', 'list').includes('autostash'));
    } finally {
      repo.dispose();
    }
  });

  it('lignes « # » d’un message reformulé gardées', async () => {
    const { repo, base } = fourCommits();
    try {
      const [c1, ...rest] = itemsFromCommits(await git.commitsForRebase(repo.root, base));
      await runInteractiveRebase(git, repo.root, base, [{ ...c1, action: 'reword', newMessage: 'c1 bis\n\n# issue 12' }, ...rest]);
      assert.equal(repo.git('log', '-1', '--format=%B', 'HEAD~3').trim(), 'c1 bis\n\n# issue 12');
    } finally {
      repo.dispose();
    }
  });
});
