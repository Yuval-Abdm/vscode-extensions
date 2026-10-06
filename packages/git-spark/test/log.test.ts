import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { GitCommands } from '../src/git/commands.ts';
import { parseLog, parseNameStatus } from '../src/git/parsers/log.ts';
import { GitRunner } from '../src/git/runner.ts';
import { makeRepo } from './helpers/repo.ts';

describe('historique', () => {
  const repo = makeRepo();
  const git = new GitCommands(new GitRunner('git'));
  const sha: Record<string, string> = {};
  before(() => {
    repo.write('f.txt', 'a\nb\nc\nd\n');
    sha.one = repo.commit('one', { author: 'Alice', email: 'alice@example.com', date: '2026-01-01T10:00:00Z' });
    repo.write('f.txt', 'a\nB\nc\nd\n');
    sha.two = repo.commit('two', { author: 'Bob', date: '2026-01-02T10:00:00Z' });
    repo.git('mv', 'f.txt', 'g.txt');
    sha.rename = repo.commit('rename', { date: '2026-01-03T10:00:00Z' });
    repo.write('g.txt', 'a\nB\nC\nd\n');
    repo.write('other.txt', 'x\n');
    sha.three = repo.commit('three', { date: '2026-01-04T10:00:00Z' });
  });
  after(() => repo.dispose());

  it("historique d'un fichier : du plus récent au plus ancien, renommage suivi", async () => {
    const entries = await git.fileHistory(repo.root, 'g.txt');
    assert.deepEqual(entries.map((e) => e.summary), ['three', 'rename', 'two', 'one']);
    assert.deepEqual(entries.map((e) => e.files), [
      [{ status: 'M', path: 'g.txt' }],
      [{ status: 'R', path: 'g.txt', oldPath: 'f.txt' }],
      [{ status: 'M', path: 'f.txt' }],
      [{ status: 'A', path: 'f.txt' }],
    ]);
    const one = entries[3];
    assert.equal(one.sha, sha.one);
    assert.deepEqual(one.parents, []);
    assert.equal(one.author, 'Alice');
    assert.equal(one.authorMail, 'alice@example.com');
    assert.equal(one.authorTime, Date.parse('2026-01-01T10:00:00Z') / 1000);
    assert.deepEqual(entries[0].parents, [sha.rename]);
  });

  it('pagination : skip et limit', async () => {
    const page = await git.fileHistory(repo.root, 'g.txt', { skip: 1, limit: 2 });
    assert.deepEqual(page.map((e) => e.summary), ['rename', 'two']);
  });

  it("historique de lignes : commits qui les ont touchées, chemin à chaque commit", async () => {
    const entries = await git.lineHistory(repo.root, 'g.txt', 2, 3);
    assert.deepEqual(entries.map((e) => e.summary), ['three', 'two', 'one']);
    assert.deepEqual(entries.map((e) => e.files), [
      [{ status: 'M', path: 'g.txt' }],
      [{ status: 'M', path: 'f.txt' }],
      [{ status: 'A', path: 'f.txt' }],
    ]);
  });

  it("fichiers d'un commit, commit racine compris", async () => {
    assert.deepEqual(await git.commitFiles(repo.root, sha.rename, sha.two), [{ status: 'R', path: 'g.txt', oldPath: 'f.txt' }]);
    assert.deepEqual(await git.commitFiles(repo.root, sha.three, sha.rename), [
      { status: 'M', path: 'g.txt' },
      { status: 'A', path: 'other.txt' },
    ]);
    assert.deepEqual(await git.commitFiles(repo.root, sha.one), [{ status: 'A', path: 'f.txt' }]);
  });

  it('fichier non suivi : historique vide', async () => {
    repo.write('untracked.txt', 'x\n');
    assert.deepEqual(await git.fileHistory(repo.root, 'untracked.txt'), []);
  });

  it('la configuration de couleur de l’utilisateur ne change pas le format', async () => {
    repo.git('config', 'color.ui', 'always');
    repo.git('config', 'diff.noprefix', 'true');
    try {
      assert.equal((await git.lineHistory(repo.root, 'g.txt', 2, 3))[0].files[0].path, 'g.txt');
      assert.equal((await git.commitFiles(repo.root, sha.one))[0].path, 'f.txt');
    } finally {
      repo.git('config', '--unset', 'color.ui');
      repo.git('config', '--unset', 'diff.noprefix');
    }
  });
});

describe('parseLog', () => {
  it('sortie vide', () => {
    assert.deepEqual(parseLog(''), []);
  });

  it('patch de -L : suppression (+++ /dev/null)', () => {
    const text = '\x00abc\x00def\x00A\x00a@x\x001\x00delete\x00\n\ndiff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n';
    assert.deepEqual(parseLog(text)[0].files, [{ status: 'D', path: 'x.txt' }]);
  });

  it('chemins entre guillemets dans --name-status', () => {
    assert.deepEqual(parseNameStatus('M\t"a\\tb.txt"\nR100\told.txt\t"n\\"ew.txt"\n'), [
      { status: 'M', path: 'a\tb.txt' },
      { status: 'R', path: 'n"ew.txt', oldPath: 'old.txt' },
    ]);
  });
});

describe('historique : cas limites (revue 0.2)', () => {
  const git = new GitCommands(new GitRunner('git'));
  it('pagination avec --follow : pas de doublon quand d’autres commits sont intercalés', async () => {
    const repo = makeRepo();
    try {
      for (let i = 0; i < 5; i++) {
        repo.write('f.txt', `v${i}\n`);
        repo.commit(`f${i}`);
        repo.write('other.txt', `o${i}\n`);
        repo.commit(`o${i}`);
      }
      const pages = [
        await git.fileHistory(repo.root, 'f.txt', { skip: 0, limit: 2 }),
        await git.fileHistory(repo.root, 'f.txt', { skip: 2, limit: 2 }),
        await git.fileHistory(repo.root, 'f.txt', { skip: 4, limit: 2 }),
      ];
      assert.deepEqual(pages.map((p) => p.map((e) => e.summary)), [['f4', 'f3'], ['f2', 'f1'], ['f0']]);
    } finally {
      repo.dispose();
    }
  });

  it('chemins pris littéralement (crochets, deux-points en tête)', async () => {
    const repo = makeRepo();
    try {
      repo.write('x1.txt', 'a\n');
      repo.commit('x1');
      repo.write('x[1].txt', 'b\n');
      repo.commit('bracket');
      repo.write(':memo.txt', 'c\n');
      repo.commit('memo');
      assert.deepEqual((await git.fileHistory(repo.root, 'x[1].txt')).map((e) => e.summary), ['bracket']);
      assert.deepEqual((await git.fileHistory(repo.root, ':memo.txt')).map((e) => e.summary), ['memo']);
    } finally {
      repo.dispose();
    }
  });

  it('merge qui modifie le fichier listé ; log.showRoot=false et diff.renames=false sans effet', async () => {
    const repo = makeRepo();
    try {
      repo.write('f.txt', 'a\nb\n');
      repo.commit('root');
      repo.git('config', 'log.showRoot', 'false');
      repo.git('config', 'diff.renames', 'false');
      repo.git('switch', '-q', '-c', 'side');
      repo.write('f.txt', 'a\nside\n');
      repo.commit('side');
      repo.git('switch', '-q', 'main');
      repo.write('f.txt', 'a\nmain\n');
      repo.commit('main');
      assert.throws(() => repo.git('merge', '-q', 'side'));
      repo.write('f.txt', 'a\nresolved\n');
      repo.git('add', 'f.txt');
      repo.git('commit', '-q', '--no-edit');
      const summaries = (await git.fileHistory(repo.root, 'f.txt')).map((e) => e.summary);
      assert.equal(summaries.length, 4);
      assert.ok(summaries.includes('root'));
      assert.match(summaries[0], /^Merge/);
      repo.git('mv', 'f.txt', 'g.txt');
      repo.commit('rename');
      const lines = await git.lineHistory(repo.root, 'g.txt', 1, 1);
      assert.equal(lines.at(-1)?.summary, 'root');
      assert.ok(lines.every((e) => e.files[0]?.status !== 'A' || e.summary === 'root'));
    } finally {
      repo.dispose();
    }
  });

  it('caractères de contrôle dans le message', async () => {
    const repo = makeRepo();
    try {
      repo.write('f.txt', 'a\n');
      repo.commit('ctrl\x1fin\x1esummary');
      assert.equal((await git.fileHistory(repo.root, 'f.txt'))[0].summary, 'ctrl\x1fin\x1esummary');
    } finally {
      repo.dispose();
    }
  });

  it("lignes de l'éditeur ramenées aux lignes de HEAD (modifications non commitées)", async () => {
    const repo = makeRepo();
    try {
      repo.write('f.txt', '1\n2\n3\n4\n5\n');
      repo.commit('root');
      const hunks = await git.diffHead(repo.root, 'f.txt', 'new a\nnew b\n1\n2\n3x\n4\n5\n');
      assert.deepEqual(hunks, [
        { oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 },
        { oldStart: 3, oldCount: 1, newStart: 5, newCount: 1 },
      ]);
    } finally {
      repo.dispose();
    }
  });
});
