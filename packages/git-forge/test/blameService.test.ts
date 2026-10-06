import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BlameService, type BlameDocument } from '../src/features/blame/service.ts';
import { GitCommands } from '../src/git/commands.ts';
import type { RepoLocator } from '../src/git/locator.ts';
import { CancelledError, GitRunner } from '../src/git/runner.ts';
import { makeRepo } from './helpers/repo.ts';

class CountingGit extends GitCommands {
  calls = 0;
  override blame(...args: Parameters<GitCommands['blame']>) {
    this.calls++;
    return super.blame(...args);
  }
}

function doc(fileName: string, text: string, version = 1): BlameDocument {
  return { fileName, version, lineCount: text.split('\n').length, getText: () => text };
}

describe('BlameService', () => {
  const repo = makeRepo();
  let head: string | undefined;
  const locator: RepoLocator = {
    locate: (fileName) => (fileName.startsWith(repo.root + path.sep) ? { root: repo.root, head } : undefined),
  };
  let git: CountingGit;
  let maxLines = 1000;
  let service: BlameService;
  const file = path.join(repo.root, 'a.txt');

  before(() => {
    repo.write('a.txt', 'one\ntwo\n');
    head = repo.commit('first', { author: 'Alice' });
  });
  after(() => repo.dispose());

  const fresh = () => {
    git = new CountingGit(new GitRunner('git'));
    service = new BlameService(git, locator, () => maxLines);
  };

  it('ligne commitée : commit, auteur, chemin relatif', async () => {
    fresh();
    const info = await service.lineInfo(doc(file, 'one\ntwo\n'), 1);
    assert.equal(info?.commit.author, 'Alice');
    assert.equal(info?.uncommitted, false);
    assert.equal(info?.relPath, 'a.txt');
    assert.equal(info?.head, head);
  });

  it('ligne modifiée non enregistrée : non commitée', async () => {
    fresh();
    const info = await service.lineInfo(doc(file, 'one\nchanged\n', 2), 1);
    assert.equal(info?.uncommitted, true);
  });

  it('ligne après la fin du blame (dernière ligne vide) : undefined', async () => {
    fresh();
    assert.equal(await service.lineInfo(doc(file, 'one\ntwo\n'), 2), undefined);
  });

  it('cache par version du document, calculs simultanés partagés', async () => {
    fresh();
    await Promise.all([service.fileBlame(doc(file, 'one\ntwo\n', 1)), service.fileBlame(doc(file, 'one\ntwo\n', 1))]);
    await service.fileBlame(doc(file, 'one\ntwo\n', 1));
    assert.equal(git.calls, 1);
    await service.fileBlame(doc(file, 'one\ntwo\nthree\n', 2));
    assert.equal(git.calls, 2);
  });

  it('fichier hors dépôt : undefined sans appeler git', async () => {
    fresh();
    assert.equal(await service.fileBlame(doc('/elsewhere/x.txt', 'x')), undefined);
    assert.equal(git.calls, 0);
  });

  it('fichier non suivi : undefined, sans exception', async () => {
    fresh();
    repo.write('untracked.txt', 'x\n');
    assert.equal(await service.fileBlame(doc(path.join(repo.root, 'untracked.txt'), 'x\n')), undefined);
  });

  it('fichier trop long : undefined sans appeler git', async () => {
    fresh();
    maxLines = 1;
    try {
      assert.equal(await service.fileBlame(doc(file, 'one\ntwo\n')), undefined);
      assert.equal(git.calls, 0);
    } finally {
      maxLines = 1000;
    }
  });

  it('dépôt sans commit (HEAD inconnu) : undefined', async () => {
    fresh();
    const saved = head;
    head = undefined;
    try {
      assert.equal(await service.fileBlame(doc(file, 'one\ntwo\n')), undefined);
    } finally {
      head = saved;
    }
  });

  it('annulation : CancelledError, puis le calcul suivant repart', async () => {
    fresh();
    await assert.rejects(service.fileBlame(doc(file, 'one\ntwo\n'), AbortSignal.abort()), CancelledError);
    const blame = await service.fileBlame(doc(file, 'one\ntwo\n'));
    assert.equal(blame?.result.lines.length, 2);
  });

  it('message complet mis en cache', async () => {
    fresh();
    assert.equal(await service.message(repo.root, head as string), 'first');
  });
});
