import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { itemsFromCommits, runInteractiveRebase } from '../src/features/operations/rebaseRun.ts';
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
});
