import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { mergeLocal } from '../src/features/merge/flow.ts';
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
      assert.deepEqual(await mergeLocal(git, local.root, { source: 'feature', noFf: false, deleteSource: 'local' }), { kind: 'conflicts' });
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
      assert.equal(steps[0], 'checkout');
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
      const outcome = await mergeLocal(git, repo.root, { source: 'feature', noFf: false, deleteSource: 'none' });
      assert.equal(outcome.kind, 'fetch-failed');
      assert.equal(repo.git('rev-parse', 'HEAD').trim(), before);
    } finally {
      repo.dispose();
    }
  });
});
