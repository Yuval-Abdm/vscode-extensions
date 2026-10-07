import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { Askpass } from '../src/git/askpass.ts';
import { GitCommands } from '../src/git/commands.ts';
import { GitRunner, promptAwareTimeout, TimeoutError, type PromptState } from '../src/git/runner.ts';
import { makeRemote } from './helpers/repo.ts';

const run = promisify(execFile);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Faux ssh : demande la passphrase par SSH_ASKPASS, attend `wait` secondes, puis lance la commande git en local. */
function fakeSsh(dir: string, wait = 0): string {
  const file = path.join(dir, 'fake-ssh.sh');
  writeFileSync(
    file,
    `#!/bin/sh
pass=$("$SSH_ASKPASS" "Enter passphrase for key 'id_test':") || { echo "cancelled" >&2; exit 255; }
[ "$pass" = secret ] || { echo "bad passphrase" >&2; exit 255; }
sleep ${wait}
shift
exec sh -c "$*"
`,
    { mode: 0o755 },
  );
  return file;
}

describe('askpass (passphrase SSH)', () => {
  it('transmet la question et renvoie la réponse ; code 1 si annulée', async () => {
    const prompts: string[] = [];
    let answer: string | undefined = 'secret';
    const askpass = await Askpass.start(async (prompt) => {
      prompts.push(prompt);
      return answer;
    });
    try {
      const env = { ...process.env, ...askpass.env };
      const { stdout } = await run(askpass.env.SSH_ASKPASS, ["Enter passphrase for key 'k':"], { env });
      assert.equal(stdout, 'secret\n');
      assert.deepEqual(prompts, ["Enter passphrase for key 'k':"]);
      answer = undefined;
      await assert.rejects(run(askpass.env.SSH_ASKPASS, ['again'], { env }), { code: 1 });
      // Mauvais jeton : refusé sans poser la question.
      await assert.rejects(run(askpass.env.SSH_ASKPASS, ['x'], { env: { ...env, GIT_SPARK_ASKPASS_TOKEN: 'nope' } }), { code: 1 });
      assert.equal(prompts.length, 2);
    } finally {
      await askpass.dispose();
    }
  });

  it('push par ssh : passphrase demandée, délai en pause pendant la saisie, arrêté au-delà du délai', async () => {
    const remote = makeRemote();
    const dir = mkdtempSync(path.join(tmpdir(), 'git-spark-ssh-'));
    let typing = 0;
    const askpass = await Askpass.start(async () => {
      await delay(typing);
      return 'secret';
    });
    try {
      const runner = new GitRunner('git');
      runner.askpass = askpass;
      const git = new GitCommands(runner);
      const a = remote.clone();
      a.git('remote', 'set-url', 'origin', `fakehost:${remote.url}`);
      a.git('config', 'ssh.variant', 'simple');
      a.git('config', 'core.sshCommand', fakeSsh(dir));
      a.write('f', '1\n');
      a.commit('c1');
      // Saisie plus longue que le délai : le push aboutit quand même.
      typing = 1500;
      assert.equal(await git.pushCurrent(a.root, 1000), 'origin/main');
      assert.equal(a.git('rev-parse', 'HEAD').trim(), execFileSync('git', ['rev-parse', 'main'], { cwd: remote.url, encoding: 'utf8' }).trim());

      typing = 0;
      a.git('config', 'core.sshCommand', fakeSsh(dir, 5));
      a.write('f', '2\n');
      a.commit('c2');
      const started = Date.now();
      await assert.rejects(git.pushCurrent(a.root, 500), TimeoutError);
      assert.ok(Date.now() - started < 4000);
    } finally {
      await askpass.dispose();
      rmSync(dir, { recursive: true, force: true });
      remote.dispose();
    }
  });
});

describe('promptAwareTimeout', () => {
  it('ne compte pas le temps passé devant une question', async () => {
    const listeners = new Set<(prompting: boolean) => void>();
    const state: PromptState & { set(value: boolean): void } = {
      prompting: false,
      onDidChangePrompting(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      set(value) {
        this.prompting = value;
        for (const listener of listeners) listener(value);
      },
    } as PromptState & { set(value: boolean): void; prompting: boolean };
    let fired = 0;
    const stop = promptAwareTimeout(200, () => fired++, state);
    await delay(100);
    state.set(true);
    await delay(300);
    assert.equal(fired, 0);
    state.set(false);
    await delay(50);
    assert.equal(fired, 0);
    await delay(150);
    assert.equal(fired, 1);
    state.set(true);
    state.set(false);
    await delay(250);
    assert.equal(fired, 1);
    stop();
    assert.equal(listeners.size, 0);
  });
});
