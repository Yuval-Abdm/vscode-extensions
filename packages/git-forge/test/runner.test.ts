import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { CancelledError, GitError, GitRunner, Limiter, runGit } from '../src/git/runner.ts';
import { makeRepo } from './helpers/repo.ts';

describe('runGit', () => {
  const repo = makeRepo();
  after(() => repo.dispose());

  it('renvoie la sortie standard', async () => {
    const { stdout } = await runGit('git', repo.root, ['rev-parse', '--is-inside-work-tree']);
    assert.equal(stdout.trim(), 'true');
  });

  it('rejette avec GitError (code de sortie et stderr) quand git échoue', async () => {
    await assert.rejects(runGit('git', repo.root, ['rev-parse', '--verify', 'nope']), (err: unknown) => {
      assert.ok(err instanceof GitError);
      assert.equal(err.exitCode, 128);
      assert.match(err.stderr, /Needed a single revision/);
      assert.deepEqual(err.args, ['rev-parse', '--verify', 'nope']);
      return true;
    });
  });

  it("envoie l'entrée standard", async () => {
    const { stdout } = await runGit('git', repo.root, ['hash-object', '--stdin'], { input: 'abc' });
    assert.equal(stdout.trim(), 'f2ba8f84ab5c1bce84a7b441cb1959cfc7093b7f');
  });

  it('rejette avec CancelledError quand le signal est annulé', async () => {
    const controller = new AbortController();
    const pending = runGit('git', repo.root, ['hash-object', '--stdin'], { input: 'abc', signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, CancelledError);
  });

  it('rejette tout de suite si le signal est déjà annulé', async () => {
    await assert.rejects(runGit('git', repo.root, ['status'], { signal: AbortSignal.abort() }), CancelledError);
  });

  it("rejette avec l'erreur de lancement quand git est introuvable", async () => {
    await assert.rejects(runGit('/nonexistent/git', repo.root, ['status']), { code: 'ENOENT' });
  });
});

describe('Limiter', () => {
  it('ne dépasse jamais le nombre de tâches simultanées', async () => {
    const limiter = new Limiter(2);
    let running = 0;
    let peak = 0;
    const task = () => limiter.run(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
    });
    await Promise.all(Array.from({ length: 10 }, task));
    assert.equal(peak, 2);
    assert.equal(running, 0);
  });

  it('libère sa place quand une tâche échoue', async () => {
    const limiter = new Limiter(1);
    await assert.rejects(limiter.run(() => Promise.reject(new Error('boom'))), /boom/);
    assert.equal(await limiter.run(async () => 42), 42);
  });
});

describe('GitRunner', () => {
  const repo = makeRepo();
  after(() => repo.dispose());

  it('lecture et écriture passent par le binaire donné', async () => {
    const runner = new GitRunner('git');
    await runner.write(repo.root, ['config', 'gitforge.test', 'yes']);
    assert.equal((await runner.read(repo.root, ['config', 'gitforge.test'])).stdout.trim(), 'yes');
  });
});
