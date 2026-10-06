import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GitCommands } from '../src/git/commands.ts';
import { parseWorkingChanges } from '../src/git/parsers/status.ts';
import { GitRunner } from '../src/git/runner.ts';
import { makeRemote, makeRepo } from './helpers/repo.ts';

const git = new GitCommands(new GitRunner('git'));

describe('commit depuis Git Forge', () => {
  it('fichiers indexés et non indexés (modifié, ajouté, supprimé, renommé, non suivi)', async () => {
    const repo = makeRepo();
    try {
      repo.write('a.txt', 'a\n');
      repo.write('b.txt', 'b\n');
      repo.write('old.txt', 'old content long enough to be detected as a rename\n');
      repo.commit('base');
      repo.write('a.txt', 'a2\n');
      repo.git('add', 'a.txt');
      repo.write('a.txt', 'a3\n');
      repo.git('rm', '-q', 'b.txt');
      repo.git('mv', 'old.txt', 'new name.txt');
      repo.write('dir/new.txt', 'n\n');
      const changes = await git.workingChanges(repo.root);
      assert.deepEqual(changes.staged, [
        { path: 'a.txt', status: 'M' },
        { path: 'b.txt', status: 'D' },
        { path: 'new name.txt', oldPath: 'old.txt', status: 'R' },
      ]);
      assert.deepEqual(changes.unstaged, [
        { path: 'a.txt', status: 'M' },
        { path: 'dir/new.txt', status: '?' },
      ]);
    } finally {
      repo.dispose();
    }
  });

  it('indexer, désindexer (y compris avant le premier commit), commiter avec le message donné', async () => {
    const repo = makeRepo();
    try {
      repo.write('first.txt', '1\n');
      await git.stage(repo.root, ['first.txt']);
      await git.unstage(repo.root, ['first.txt']);
      assert.deepEqual((await git.workingChanges(repo.root)).staged, []);
      await git.stage(repo.root, ['first.txt']);
      await git.commitWithMessage(repo.root, 'feat: premier commit\n\n# gardé');
      assert.equal(repo.git('log', '-1', '--format=%B').trim(), 'feat: premier commit\n\n# gardé');
      repo.write('first.txt', '2\n');
      await git.stage(repo.root, ['first.txt']);
      await git.unstage(repo.root, ['first.txt']);
      assert.deepEqual((await git.workingChanges(repo.root)).unstaged, [{ path: 'first.txt', status: 'M' }]);
    } finally {
      repo.dispose();
    }
  });

  it('pull --rebase avant commit (index gardé), puis push ; nouvelle branche poussée avec -u', async () => {
    const remote = makeRemote();
    try {
      const a = remote.clone();
      a.write('f', '1\n');
      a.commit('c1');
      a.git('push', '-q', '-u', 'origin', 'main');
      const b = remote.clone();
      b.write('g', '2\n');
      b.commit('c2');
      b.git('push', '-q');
      a.write('s', 'staged\n');
      await git.stage(a.root, ['s']);
      a.write('u', 'not staged\n');
      assert.equal(await git.pullRebase(a.root), 'done');
      assert.deepEqual((await git.workingChanges(a.root)).staged, [{ path: 's', status: 'A' }]);
      await git.commitWithMessage(a.root, 'fix: après pull');
      assert.equal(await git.pushCurrent(a.root), 'origin/main');
      assert.equal(a.git('rev-parse', 'HEAD').trim(), a.git('ls-remote', 'origin', 'refs/heads/main').split('\t')[0]);
      a.git('switch', '-q', '-c', 'topic');
      a.write('t', 't\n');
      a.commit('topic');
      assert.equal(await git.pullRebase(a.root), 'no-upstream');
      assert.equal(await git.pushCurrent(a.root), 'origin/topic');
      assert.equal(a.git('rev-parse', '--abbrev-ref', 'topic@{upstream}').trim(), 'origin/topic');
    } finally {
      remote.dispose();
    }
  });

  it('pull en conflit : « conflicts », rien de commité', async () => {
    const remote = makeRemote();
    try {
      const a = remote.clone();
      a.write('f', '1\n');
      a.commit('c1');
      a.git('push', '-q', '-u', 'origin', 'main');
      const b = remote.clone();
      b.write('f', 'theirs\n');
      b.commit('theirs');
      b.git('push', '-q');
      a.write('f', 'mine\n');
      a.commit('mine (not pushed)');
      assert.equal(await git.pullRebase(a.root), 'conflicts');
      assert.equal((await git.operation(a.root))?.kind, 'rebase');
    } finally {
      remote.dispose();
    }
  });

  it('format porcelain v2 : conflit et chemin avec espaces', () => {
    const text = ['u UU N... 100644 100644 100644 100644 h1 h2 h3 x y.txt', '? new file.txt', ''].join('\0');
    assert.deepEqual(parseWorkingChanges(text), {
      staged: [],
      unstaged: [
        { path: 'x y.txt', status: 'U' },
        { path: 'new file.txt', status: '?' },
      ],
    });
  });
});
