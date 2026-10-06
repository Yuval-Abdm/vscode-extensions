import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GitCommands, type RefInfo } from '../src/git/commands.ts';
import { GitRunner } from '../src/git/runner.ts';
import { branchChoices } from '../src/features/commit/branches.ts';
import { makeRemote, makeRepo } from './helpers/repo.ts';

const git = new GitCommands(new GitRunner('git'));
const ref = (kind: RefInfo['kind'], name: string): RefInfo => ({ kind, name, ref: `refs/x/${name}`, sha: '0' });

describe('changement de branche depuis la vue Commit', () => {
  it('branche courante en tête, distantes sans locale du même nom, tags ignorés', () => {
    const choices = branchChoices(
      [ref('branch', 'dev'), ref('branch', 'main'), ref('remote', 'origin/main'), ref('remote', 'origin/feature/x'), ref('remote', 'upstream/feature/x'), ref('tag', 'v1')],
      'main',
    );
    assert.deepEqual(choices, [
      { kind: 'local', name: 'main', current: true },
      { kind: 'local', name: 'dev', current: false },
      { kind: 'remote', name: 'feature/x', remoteBranch: 'origin/feature/x' },
    ]);
  });

  it('extraire une branche distante crée la branche locale qui la suit ; créer une branche la rend courante', async () => {
    const remote = makeRemote();
    try {
      const a = remote.clone();
      a.write('f', '1\n');
      a.commit('c1');
      a.git('push', '-q', '-u', 'origin', 'main');
      a.git('checkout', '-q', '-b', 'feature/x');
      a.git('push', '-q', '-u', 'origin', 'feature/x');
      const b = remote.clone();
      await git.checkoutTracking(b.root, 'feature/x', 'origin/feature/x');
      assert.equal(b.git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feature/x');
      assert.equal(b.git('rev-parse', '--abbrev-ref', '@{upstream}').trim(), 'origin/feature/x');
      const repo = makeRepo();
      try {
        repo.write('g', '1\n');
        repo.commit('c1');
        await git.checkoutNew(repo.root, 'new-one');
        assert.equal(repo.git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'new-one');
      } finally {
        repo.dispose();
      }
    } finally {
      remote.dispose();
    }
  });
});

describe('annuler les modifications depuis la vue Commit', () => {
  it('fichier suivi remis à la version indexée, fichier non suivi supprimé, index conservé', async () => {
    const repo = makeRepo();
    try {
      repo.write('a.txt', 'a\n');
      repo.write('b.txt', 'b\n');
      repo.commit('base');
      repo.write('a.txt', 'a2\n');
      repo.git('add', 'a.txt');
      repo.write('a.txt', 'a3\n');
      repo.write('b.txt', 'b2\n');
      repo.write('dir/new.txt', 'n\n');
      await git.discard(repo.root, ['a.txt', 'b.txt'], ['dir/new.txt']);
      const changes = await git.workingChanges(repo.root);
      assert.deepEqual(changes.staged.map((c) => c.path), ['a.txt']);
      assert.deepEqual(changes.unstaged, []);
      assert.equal(repo.git('show', ':a.txt'), 'a2\n');
      assert.equal(repo.git('diff', '--', 'a.txt'), '');
    } finally {
      repo.dispose();
    }
  });
});
