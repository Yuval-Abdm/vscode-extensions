import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { GitCommands, StashKeptError } from '../src/git/commands.ts';
import { parseWorkingChanges } from '../src/git/parsers/status.ts';
import { GitRunner } from '../src/git/runner.ts';
import { makeRemote, makeRepo } from './helpers/repo.ts';

const git = new GitCommands(new GitRunner('git'));

describe('commit depuis Git Spark', () => {
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

describe('vue Commit : cas limites (revue)', () => {
  /** a : branche main poussée ; b pousse un commit qui touche un autre fichier. */
  function behindRemote() {
    const remote = makeRemote();
    const a = remote.clone();
    a.write('f.txt', '1\n2\n3\n');
    a.write('g.txt', 'g\n');
    a.commit('base');
    a.git('push', '-q', '-u', 'origin', 'main');
    const b = remote.clone();
    b.write('other.txt', 'remote\n');
    b.commit('remote work');
    b.git('push', '-q');
    return { remote, a };
  }

  it('pull avant commit : indexation exacte gardée (modification, indexation partielle, nouveau fichier)', async () => {
    const { remote, a } = behindRemote();
    try {
      a.write('f.txt', 'ONE\n2\n3\n');
      a.git('add', 'f.txt');
      a.write('f.txt', 'ONE\n2\nTHREE\n'); // partiellement indexé
      a.write('g.txt', 'g2\n');
      a.git('add', 'g.txt');
      a.write('n.txt', 'new\n');
      a.git('add', 'n.txt');
      const before = a.git('status', '--porcelain');
      assert.equal(await git.pullBeforeCommit(a.root), 'done');
      assert.equal(a.git('status', '--porcelain'), before);
      assert.equal(a.git('show', ':f.txt'), 'ONE\n2\n3\n');
      assert.equal(a.git('log', '-1', '--format=%s').trim(), 'remote work');
      assert.equal(a.git('stash', 'list').trim(), '');
    } finally {
      remote.dispose();
    }
  });

  it('pull avant commit : modifications en conflit avec le pull → signalé, gardées dans le stash', async () => {
    const remote = makeRemote();
    try {
      const a = remote.clone();
      a.write('f.txt', '1\n');
      a.commit('base');
      a.git('push', '-q', '-u', 'origin', 'main');
      const b = remote.clone();
      b.write('f.txt', 'remote\n');
      b.commit('remote');
      b.git('push', '-q');
      a.write('f.txt', 'local\n');
      a.git('add', 'f.txt');
      assert.equal(await git.pullBeforeCommit(a.root), 'stash-conflicts');
      assert.ok(a.git('stash', 'list').trim());
    } finally {
      remote.dispose();
    }
  });

  it('désindexer un renommage : l’ancien chemin aussi ; avant le premier commit, fichier modifié après add', async () => {
    const repo = makeRepo();
    try {
      repo.write('first.txt', '1\n');
      repo.git('add', 'first.txt');
      repo.write('first.txt', '2\n');
      await git.unstage(repo.root, ['first.txt']);
      assert.deepEqual((await git.workingChanges(repo.root)).staged, []);
      repo.git('add', 'first.txt');
      repo.commit('base');
      repo.git('mv', 'first.txt', 'h h.txt');
      await git.unstage(repo.root, ['h h.txt', 'first.txt']);
      assert.deepEqual((await git.workingChanges(repo.root)).staged, []);
    } finally {
      repo.dispose();
    }
  });

  it('noms de fichiers pris littéralement (x*.txt)', async () => {
    const repo = makeRepo();
    try {
      repo.write('base', 'b\n');
      repo.commit('base');
      for (const name of ['x*.txt', 'x1.txt', 'x2.txt']) repo.write(name, 'x\n');
      await git.stage(repo.root, ['x*.txt']);
      assert.deepEqual((await git.workingChanges(repo.root)).staged.map((c) => c.path), ['x*.txt']);
    } finally {
      repo.dispose();
    }
  });
});

describe('pull avant commit : fichier réécrit par un autre programme (minifier, formatter…)', () => {
  /** Runner qui simule un watcher : juste après `stash push`, `write(root)` réécrit un fichier de l'arbre de travail. */
  function gitWithWatcher(write: (root: string) => void): GitCommands {
    const runner = new GitRunner('git');
    const original = runner.write.bind(runner);
    runner.write = async (cwd, args, options) => {
      const result = await original(cwd, args, options);
      if (args[0] === 'stash' && args[1] === 'push') write(cwd);
      return result;
    };
    return new GitCommands(runner);
  }

  /** a : style.css et style.min.css poussés, puis modifiés et indexés. */
  function stagedCss(remote: ReturnType<typeof makeRemote>) {
    const a = remote.clone();
    a.write('style.css', 'a{}\n');
    a.write('style.min.css', 'a{}');
    a.commit('base');
    a.git('push', '-q', '-u', 'origin', 'main');
    return a;
  }

  function editCss(a: ReturnType<ReturnType<typeof makeRemote>['clone']>) {
    a.write('style.css', 'a{margin:0}\n');
    a.write('style.min.css', 'a{margin:0}');
    a.git('add', '-A');
  }

  const regenerate = (root: string) => writeFileSync(path.join(root, 'style.min.css'), 'regenerated');

  it('déjà à jour avec le distant : rien n’est mis de côté, les modifications restent en place', async () => {
    const remote = makeRemote();
    try {
      const a = stagedCss(remote);
      editCss(a);
      const before = a.git('status', '--porcelain');
      assert.equal(await gitWithWatcher(regenerate).pullBeforeCommit(a.root), 'done');
      assert.equal(a.git('status', '--porcelain'), before);
      assert.equal(a.git('show', ':style.min.css'), 'a{margin:0}');
      assert.equal(a.git('stash', 'list').trim(), '');
    } finally {
      remote.dispose();
    }
  });

  it('en retard sur le distant : modifications gardées dans le stash, erreur qui nomme le fichier réécrit', async () => {
    const remote = makeRemote();
    try {
      const a = stagedCss(remote);
      const b = remote.clone();
      b.write('other.txt', 'remote\n');
      b.commit('remote work');
      b.git('push', '-q');
      editCss(a);
      await assert.rejects(gitWithWatcher(regenerate).pullBeforeCommit(a.root), (err: unknown) => {
        assert.ok(err instanceof StashKeptError);
        assert.deepEqual(err.files, ['style.min.css']);
        return true;
      });
      assert.match(a.git('stash', 'list'), /git-spark: before pull/);
      assert.equal(a.git('show', 'stash@{0}:style.css'), 'a{margin:0}\n');
    } finally {
      remote.dispose();
    }
  });
});
