import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { GitCommands } from '../src/git/commands.ts';
import { isUncommitted, parseBlameIncremental } from '../src/git/parsers/blame.ts';
import { GitRunner } from '../src/git/runner.ts';
import { makeRepo } from './helpers/repo.ts';

describe('blame', () => {
  const repo = makeRepo();
  const git = new GitCommands(new GitRunner('git'));
  let first = '';
  let second = '';
  before(() => {
    repo.write('a.txt', 'one\ntwo\nthree\n');
    first = repo.commit('first commit', { author: 'Alice', email: 'alice@example.com', date: '2026-01-01T10:00:00Z' });
    repo.write('a.txt', 'one\nTWO\nthree\nfour\n');
    second = repo.commit('second commit\n\nbody line', { author: 'Bob', email: 'bob@example.com', date: '2026-02-01T10:00:00Z' });
  });
  after(() => repo.dispose());

  it('attribue chaque ligne à son commit, avec auteur, date et parent', async () => {
    const result = await git.blame(repo.root, 'a.txt');
    assert.deepEqual(result.lines, [first, second, first, second]);
    const bob = result.commits.get(second);
    assert.ok(bob);
    assert.equal(bob.author, 'Bob');
    assert.equal(bob.authorMail, 'bob@example.com');
    assert.equal(bob.authorTime, Date.parse('2026-02-01T10:00:00Z') / 1000);
    assert.equal(bob.summary, 'second commit');
    assert.equal(bob.filename, 'a.txt');
    assert.deepEqual(bob.previous, { sha: first, filename: 'a.txt' });
    assert.equal(result.commits.get(first)?.previous, undefined);
  });

  it("travaille sur le contenu de l'éditeur : lignes ajoutées non commitées", async () => {
    const result = await git.blame(repo.root, 'a.txt', { contents: 'one\nTWO\nnew line\nthree\nfour\n' });
    assert.equal(result.lines.length, 5);
    assert.ok(isUncommitted(result.lines[2]));
    assert.deepEqual([result.lines[0], result.lines[1], result.lines[3], result.lines[4]], [first, second, first, second]);
  });

  it('chemins avec espaces et accents', async () => {
    repo.write('dossier é/fichier a.txt', 'x\n');
    const sha = repo.commit('accents');
    const result = await git.blame(repo.root, 'dossier é/fichier a.txt');
    assert.deepEqual(result.lines, [sha]);
    assert.equal(result.commits.get(sha)?.filename, 'dossier é/fichier a.txt');
    assert.equal(await git.show(repo.root, sha, 'dossier é/fichier a.txt'), 'x\n');
  });

  it("contenu d'un fichier à un commit, message complet, HEAD", async () => {
    assert.equal(await git.show(repo.root, first, 'a.txt'), 'one\ntwo\nthree\n');
    assert.equal(await git.message(repo.root, second), 'second commit\n\nbody line');
    assert.equal(await git.head(repo.root), repo.git('rev-parse', 'HEAD').trim());
  });

  it('après un renommage, les anciennes lignes gardent leur ancien nom de fichier', async () => {
    repo.git('mv', 'a.txt', 'b.txt');
    repo.write('b.txt', 'one\nTWO\nthree\nfour\nfive\n');
    const third = repo.commit('rename');
    const result = await git.blame(repo.root, 'b.txt');
    assert.equal(result.lines[4], third);
    assert.equal(result.commits.get(first)?.filename, 'a.txt');
    assert.deepEqual(result.commits.get(third)?.previous, { sha: repo.git('rev-parse', `${third}^`).trim(), filename: 'a.txt' });
  });

  it('sortie vide : aucune ligne', () => {
    assert.deepEqual(parseBlameIncremental(''), { commits: new Map(), lines: [] });
  });
});

describe('head', () => {
  it('dépôt sans commit : undefined', async () => {
    const repo = makeRepo();
    try {
      assert.equal(await new GitCommands(new GitRunner('git')).head(repo.root), undefined);
    } finally {
      repo.dispose();
    }
  });
});
