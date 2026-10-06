import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { GitCommands } from '../src/git/commands.ts';
import { GitRunner } from '../src/git/runner.ts';
import { makeRepo, type TestRepo } from './helpers/repo.ts';

const git = new GitCommands(new GitRunner('git'));

/** main : c1, c2 ; branche other depuis c1 : o1 (o.txt), o2 (modifie f) ; merge de other dans side. */
function repoWithBranch(): TestRepo {
  const repo = makeRepo();
  repo.write('f', '1\n');
  repo.commit('c1');
  repo.git('switch', '-q', '-c', 'other');
  repo.write('o.txt', 'o\n');
  repo.commit('o1');
  repo.write('f', 'other\n');
  repo.commit('o2');
  repo.git('switch', '-q', 'main');
  repo.write('f', '2\n');
  repo.commit('c2');
  return repo;
}

describe('opérations', () => {
  it('cherry-pick sans conflit, puis avec conflit', async () => {
    const repo = repoWithBranch();
    try {
      const o1 = repo.git('rev-parse', 'other~1').trim();
      assert.equal(await git.cherryPick(repo.root, o1), 'done');
      assert.ok(existsSync(path.join(repo.root, 'o.txt')));
      assert.equal(repo.git('log', '-1', '--format=%s').trim(), 'o1');
      assert.equal(await git.cherryPick(repo.root, repo.git('rev-parse', 'other').trim()), 'conflicts');
      assert.equal((await git.operation(repo.root))?.kind, 'cherry-pick');
    } finally {
      repo.dispose();
    }
  });

  it('cherry-pick déjà appliqué : arrêté (commit vide)', async () => {
    const repo = repoWithBranch();
    try {
      const o1 = repo.git('rev-parse', 'other~1').trim();
      await git.cherryPick(repo.root, o1);
      assert.equal(await git.cherryPick(repo.root, o1), 'stopped');
    } finally {
      repo.dispose();
    }
  });

  it('revert, et revert d’un merge par rapport à son premier parent', async () => {
    const repo = repoWithBranch();
    try {
      const c2 = repo.git('rev-parse', 'HEAD').trim();
      assert.equal(await git.revert(repo.root, c2), 'done');
      assert.equal(repo.git('show', 'HEAD:f'), '1\n');
      repo.git('switch', '-q', '-c', 'side', 'other~1');
      repo.write('s.txt', 's\n');
      repo.commit('s1');
      repo.git('merge', '-q', '--no-edit', 'other');
      const merge = repo.git('rev-parse', 'HEAD').trim();
      assert.equal(await git.revert(repo.root, merge, 1), 'done');
      assert.equal(repo.git('show', 'HEAD:f'), '1\n');
      assert.ok(existsSync(path.join(repo.root, 's.txt')));
    } finally {
      repo.dispose();
    }
  });

  it('reset soft, mixed, hard ; fichiers modifiés ; tag de sauvegarde', async () => {
    const repo = repoWithBranch();
    try {
      const c1 = repo.git('rev-parse', 'HEAD~1').trim();
      const c2 = repo.git('rev-parse', 'HEAD').trim();
      const tag = await git.backupTag(repo.root);
      assert.match(tag, /^git-forge\/backup\/\d{8}T\d{6}Z$/);
      assert.equal(repo.git('rev-parse', `${tag}^{commit}`).trim(), c2);
      await git.reset(repo.root, c1, 'soft');
      assert.equal(repo.git('diff', '--cached', '--name-only').trim(), 'f');
      await git.reset(repo.root, c1, 'mixed');
      assert.deepEqual(await git.changedFiles(repo.root), ['f']);
      await git.reset(repo.root, c1, 'hard');
      assert.deepEqual(await git.changedFiles(repo.root), []);
      assert.equal(repo.git('rev-parse', 'HEAD').trim(), c1);
    } finally {
      repo.dispose();
    }
  });

  it('commit et commits à rebaser (du plus ancien au plus récent, message complet)', async () => {
    const repo = repoWithBranch();
    try {
      repo.write('g', 'g\n');
      repo.commit('c3\n\nbody');
      const base = repo.git('rev-parse', 'HEAD~2').trim();
      const commits = await git.commitsForRebase(repo.root, base);
      assert.deepEqual(commits.map((c) => [c.summary, c.message]), [['c2', 'c2'], ['c3', 'c3\n\nbody']]);
      assert.equal((await git.commit(repo.root, 'HEAD'))?.summary, 'c3');
      assert.equal(await git.commit(repo.root, 'nope'), undefined);
    } finally {
      repo.dispose();
    }
  });
});
