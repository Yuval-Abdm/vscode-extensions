import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { deleteSourceBranch, mergeLocal, settlePendingDelete } from '../src/features/merge/flow.ts';
import { GitCommands } from '../src/git/commands.ts';
import { GitRunner } from '../src/git/runner.ts';
import { makeRemote, makeRepo, type TestRemote, type TestRepo } from './helpers/repo.ts';

const git = new GitCommands(new GitRunner('git'));

/** Dépôt distant avec main et feature poussées ; `local` est sur main, à jour. */
function setup(): { remote: TestRemote; local: TestRepo } {
  const remote = makeRemote();
  const local = remote.clone();
  local.write('base.txt', 'base\n');
  local.commit('base');
  local.git('push', '-q', '-u', 'origin', 'main');
  local.git('switch', '-q', '-c', 'feature');
  local.write('feature.txt', 'feature\n');
  local.commit('feature work');
  local.git('push', '-q', '-u', 'origin', 'feature');
  local.git('switch', '-q', 'main');
  return { remote, local };
}

/** Un autre clone pousse un commit sur `branch`. */
function pushFromElsewhere(remote: TestRemote, branch: string, file: string): void {
  const other = remote.clone();
  other.git('switch', '-q', branch);
  other.write(file, `${file}\n`);
  other.commit(`remote ${file}`);
  other.git('push', '-q');
}

const has = (repo: TestRepo, file: string) => existsSync(path.join(repo.root, file));

describe('merge local', () => {
  it('met à jour la cible et la source depuis le remote, puis merge', async () => {
    const { remote, local } = setup();
    try {
      pushFromElsewhere(remote, 'feature', 'remote-feature.txt');
      pushFromElsewhere(remote, 'main', 'remote-main.txt');
      const steps: string[] = [];
      const outcome = await mergeLocal(git, local.root, { source: 'feature', noFf: false, deleteSource: 'none' }, (s) => steps.push(s));
      assert.deepEqual(outcome, { kind: 'merged', upToDate: false, deleted: 'none' });
      assert.deepEqual(steps, ['fetch', 'update-target', 'update-source', 'merge']);
      for (const file of ['feature.txt', 'remote-feature.txt', 'remote-main.txt']) assert.ok(has(local, file), file);
      assert.equal(local.git('rev-parse', 'feature').trim(), local.git('rev-parse', 'origin/feature').trim());
    } finally {
      remote.dispose();
    }
  });

  it('cible divergée de sa branche distante : arrêt, rien de modifié', async () => {
    const { remote, local } = setup();
    try {
      pushFromElsewhere(remote, 'main', 'remote-main.txt');
      local.write('local.txt', 'local\n');
      const before = local.commit('local main work');
      const outcome = await mergeLocal(git, local.root, { source: 'feature', noFf: false, deleteSource: 'none' });
      assert.deepEqual(outcome, { kind: 'diverged', branch: 'main' });
      assert.equal(local.git('rev-parse', 'HEAD').trim(), before);
      assert.equal(await git.operation(local.root), undefined);
    } finally {
      remote.dispose();
    }
  });

  it('source divergée : arrêt', async () => {
    const { remote, local } = setup();
    try {
      pushFromElsewhere(remote, 'feature', 'remote-feature.txt');
      local.git('switch', '-q', 'feature');
      local.write('local-feature.txt', 'x\n');
      local.commit('local feature work');
      local.git('switch', '-q', 'main');
      assert.deepEqual(await mergeLocal(git, local.root, { source: 'feature', noFf: false, deleteSource: 'none' }), { kind: 'diverged', branch: 'feature' });
    } finally {
      remote.dispose();
    }
  });

  it('source en avance sur sa branche distante : ses commits sont mergés', async () => {
    const { remote, local } = setup();
    try {
      local.git('switch', '-q', 'feature');
      local.write('unpushed.txt', 'x\n');
      local.commit('unpushed');
      local.git('switch', '-q', 'main');
      const outcome = await mergeLocal(git, local.root, { source: 'feature', noFf: false, deleteSource: 'none' });
      assert.equal(outcome.kind, 'merged');
      assert.ok(has(local, 'unpushed.txt'));
    } finally {
      remote.dispose();
    }
  });

  it('arbre de travail modifié : dirty, sans fetch', async () => {
    const { remote, local } = setup();
    try {
      local.write('base.txt', 'changed\n');
      const steps: string[] = [];
      assert.deepEqual(await mergeLocal(git, local.root, { source: 'feature', noFf: false, deleteSource: 'none' }, (s) => steps.push(s)), { kind: 'dirty' });
      assert.deepEqual(steps, []);
    } finally {
      remote.dispose();
    }
  });

  it('conflits : merge en cours, branche source gardée', async () => {
    const { remote, local } = setup();
    try {
      local.git('switch', '-q', 'feature');
      local.write('base.txt', 'feature side\n');
      local.commit('feature edits base');
      local.git('push', '-q');
      local.git('switch', '-q', 'main');
      local.write('base.txt', 'main side\n');
      local.commit('main edits base');
      local.git('push', '-q');
      const outcome = await mergeLocal(git, local.root, { source: 'feature', noFf: false, deleteSource: 'local' });
      assert.deepEqual(outcome, { kind: 'conflicts', sourceSha: local.git('rev-parse', 'feature').trim() });
      assert.equal((await git.operation(local.root))?.kind, 'merge');
      assert.ok(local.git('branch', '--list', 'feature').trim());
    } finally {
      remote.dispose();
    }
  });

  it('suppression locale et distante après le merge', async () => {
    const { remote, local } = setup();
    try {
      const outcome = await mergeLocal(git, local.root, { source: 'feature', noFf: true, deleteSource: 'remote' });
      assert.deepEqual(outcome, { kind: 'merged', upToDate: false, deleted: 'remote' });
      assert.equal(local.git('branch', '--list', 'feature').trim(), '');
      assert.equal(local.git('ls-remote', '--heads', 'origin', 'feature').trim(), '');
      assert.equal(local.git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').length, 3);
    } finally {
      remote.dispose();
    }
  });

  it('cible différente de la branche courante : checkout puis merge', async () => {
    const { remote, local } = setup();
    try {
      local.git('switch', '-q', '-c', 'release');
      local.git('switch', '-q', 'feature');
      const steps: string[] = [];
      const outcome = await mergeLocal(git, local.root, { source: 'feature', target: 'release', noFf: false, deleteSource: 'none' }, (s) => steps.push(s));
      assert.equal(outcome.kind, 'merged');
      assert.ok(steps.includes('checkout'));
      assert.equal(local.git('branch', '--show-current').trim(), 'release');
      assert.ok(has(local, 'feature.txt'));
    } finally {
      remote.dispose();
    }
  });

  it('sans remote : pas de fetch ; déjà mergé : up-to-date', async () => {
    const repo = makeRepo();
    try {
      repo.write('a.txt', 'a\n');
      repo.commit('a');
      repo.git('branch', 'old');
      const steps: string[] = [];
      const outcome = await mergeLocal(git, repo.root, { source: 'old', noFf: false, deleteSource: 'local' }, (s) => steps.push(s));
      assert.deepEqual(outcome, { kind: 'merged', upToDate: true, deleted: 'local' });
      assert.ok(!steps.includes('fetch'));
    } finally {
      repo.dispose();
    }
  });

  it('fetch impossible (remote introuvable) : fetch-failed, rien de modifié', async () => {
    const repo = makeRepo();
    try {
      repo.write('a.txt', 'a\n');
      const before = repo.commit('a');
      repo.git('branch', 'feature');
      repo.git('remote', 'add', 'origin', path.join(repo.root, 'does-not-exist'));
      repo.git('config', 'branch.main.remote', 'origin');
      repo.git('config', 'branch.main.merge', 'refs/heads/main');
      const outcome = await mergeLocal(git, repo.root, { source: 'feature', noFf: false, deleteSource: 'none' });
      assert.equal(outcome.kind, 'fetch-failed');
      assert.equal(repo.git('rev-parse', 'HEAD').trim(), before);
    } finally {
      repo.dispose();
    }
  });

  it('source divergée : rien n’est modifié (ni checkout, ni avance de la cible)', async () => {
    const { remote, local } = setup();
    try {
      pushFromElsewhere(remote, 'main', 'remote-main.txt');
      pushFromElsewhere(remote, 'feature', 'remote-feature.txt');
      local.git('switch', '-q', 'feature');
      local.write('local-feature.txt', 'x\n');
      local.commit('local feature work');
      local.git('switch', '-q', '-c', 'other');
      const main = local.git('rev-parse', 'main').trim();
      assert.deepEqual(await mergeLocal(git, local.root, { source: 'feature', target: 'main', noFf: false, deleteSource: 'none' }), { kind: 'diverged', branch: 'feature' });
      assert.equal(local.git('branch', '--show-current').trim(), 'other');
      assert.equal(local.git('rev-parse', 'main').trim(), main);
    } finally {
      remote.dispose();
    }
  });

  it('opération en cours : refus', async () => {
    const repo = makeRepo();
    try {
      repo.write('f.txt', 'base\n');
      repo.commit('base');
      repo.git('switch', '-q', '-c', 'feature');
      repo.write('f.txt', 'theirs\n');
      repo.commit('theirs');
      repo.git('switch', '-q', 'main');
      repo.write('f.txt', 'ours\n');
      repo.commit('ours');
      assert.throws(() => repo.git('merge', '-q', 'feature'));
      repo.write('f.txt', 'resolved\n');
      repo.git('add', 'f.txt');
      assert.deepEqual(await mergeLocal(git, repo.root, { source: 'feature', noFf: false, deleteSource: 'none' }), { kind: 'busy', operation: 'merge' });
    } finally {
      repo.dispose();
    }
  });

  it('tag du même nom que la branche : c’est la branche qui est mergée', async () => {
    const repo = makeRepo();
    try {
      repo.write('a.txt', 'a\n');
      repo.commit('base');
      repo.git('switch', '-q', '-c', 'feat');
      repo.write('f1.txt', '1\n');
      repo.commit('f1');
      repo.git('tag', 'feat');
      repo.write('f2.txt', '2\n');
      repo.commit('f2');
      repo.git('switch', '-q', 'main');
      assert.equal((await mergeLocal(git, repo.root, { source: 'feat', noFf: false, deleteSource: 'none' })).kind, 'merged');
      assert.ok(has(repo, 'f2.txt'));
    } finally {
      repo.dispose();
    }
  });

  it('source qui suit une branche locale : ni avancée, ni suppression de l’autre branche', async () => {
    const repo = makeRepo();
    try {
      repo.write('a.txt', 'a\n');
      repo.commit('base');
      repo.git('branch', 'develop');
      repo.git('switch', '-q', '--track', '-c', 'feat', 'develop');
      repo.write('feat.txt', 'f\n');
      repo.commit('feat');
      repo.git('switch', '-q', 'develop');
      repo.write('dev.txt', 'd\n');
      repo.commit('dev only');
      repo.git('switch', '-q', 'main');
      const outcome = await mergeLocal(git, repo.root, { source: 'feat', noFf: false, deleteSource: 'remote' });
      assert.deepEqual(outcome, { kind: 'merged', upToDate: false, deleted: 'local' });
      assert.ok(!has(repo, 'dev.txt'));
      assert.ok(repo.git('branch', '--list', 'develop').trim());
    } finally {
      repo.dispose();
    }
  });

  it('suppression refusée pour une branche non contenue dans HEAD (même poussée)', async () => {
    const { remote, local } = setup();
    try {
      const outcome = await deleteSourceBranch(git, local.root, 'feature', 'remote');
      assert.equal(outcome.deleted, 'none');
      assert.ok(local.git('branch', '--list', 'feature').trim());
      assert.ok(local.git('ls-remote', '--heads', 'origin', 'feature').trim());
    } finally {
      remote.dispose();
    }
  });

  it('suppression en attente : faite si le merge commité est celui de la source, oubliée sinon', async () => {
    const { remote, local } = setup();
    try {
      local.git('switch', '-q', 'feature');
      local.write('base.txt', 'feature side\n');
      local.commit('feature edits base');
      local.git('switch', '-q', 'main');
      local.write('base.txt', 'main side\n');
      local.commit('main edits base');
      const outcome = await mergeLocal(git, local.root, { source: 'feature', noFf: false, deleteSource: 'local' });
      assert.equal(outcome.kind, 'conflicts');
      const pending = { root: local.root, source: 'feature', target: 'main', sourceSha: outcome.kind === 'conflicts' ? outcome.sourceSha : '', mode: 'local' as const };
      assert.equal(await settlePendingDelete(git, pending), 'wait');
      local.write('base.txt', 'resolved\n');
      local.git('add', 'base.txt');
      local.git('commit', '-q', '--no-edit'); // commité hors de Git Forge
      assert.deepEqual(await settlePendingDelete(git, pending), { deleted: 'local' });
      assert.equal(local.git('branch', '--list', 'feature').trim(), '');
      assert.equal(await settlePendingDelete(git, { ...pending, sourceSha: 'deadbeef' }), 'drop');
    } finally {
      remote.dispose();
    }
  });

  it('branche source extraite dans un autre worktree et en retard : refus, rien de modifié', async () => {
    const { remote, local } = setup();
    try {
      pushFromElsewhere(remote, 'feature', 'remote-feature.txt');
      const dir = path.join(path.dirname(local.root), `${path.basename(local.root)}-wt`);
      local.git('worktree', 'add', '-q', dir, 'feature');
      try {
        const outcome = await mergeLocal(git, local.root, { source: 'feature', noFf: false, deleteSource: 'none' });
        assert.equal(outcome.kind, 'checked-out-elsewhere');
        assert.equal(local.git('rev-parse', 'HEAD').trim(), local.git('rev-parse', 'main').trim());
      } finally {
        local.git('worktree', 'remove', '--force', dir);
      }
    } finally {
      remote.dispose();
    }
  });

  it('merge.ff=only dans la configuration : le commit de merge est quand même créé', async () => {
    const { remote, local } = setup();
    try {
      local.git('config', 'merge.ff', 'only');
      local.write('main.txt', 'm\n');
      local.commit('main work');
      const outcome = await mergeLocal(git, local.root, { source: 'feature', noFf: false, deleteSource: 'none' });
      assert.equal(outcome.kind, 'merged');
      assert.ok(has(local, 'feature.txt'));
    } finally {
      remote.dispose();
    }
  });
});
