// Demandes de git et ssh (passphrase de clé SSH, identifiants HTTPS) posées à l'utilisateur : SSH_ASKPASS / GIT_ASKPASS
// pointent vers un petit script qui transmet la question à l'extension par un socket local et renvoie la réponse.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Limiter, type PromptState } from './runner.ts';

/** Pose la question ; undefined si l'utilisateur annule. */
export type Ask = (prompt: string) => PromiseLike<string | undefined>;

// Lancé par ssh / git avec la question en argument : réponse sur la sortie standard, code 1 si annulé.
const MAIN = `const net = require('node:net');
const socket = net.connect(process.env.GIT_SPARK_ASKPASS_PIPE);
let data = '';
socket.setEncoding('utf8');
socket.on('connect', () => socket.write(JSON.stringify({ token: process.env.GIT_SPARK_ASKPASS_TOKEN, prompt: process.argv.slice(2).join(' ') }) + '\\n'));
socket.on('data', (chunk) => { data += chunk; });
socket.on('end', () => {
  try {
    const answer = JSON.parse(data);
    if (typeof answer.value === 'string') return void process.stdout.write(answer.value + '\\n');
  } catch {}
  process.exitCode = 1;
});
socket.on('error', () => { process.exitCode = 1; });
`;

// Exécutable de l'extension (Electron en mode Node, ou Node du serveur distant).
const SCRIPT = `#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "$GIT_SPARK_ASKPASS_NODE" "$GIT_SPARK_ASKPASS_MAIN" "$@"
`;

export class Askpass implements PromptState {
  /** Variables d'environnement à donner à git. */
  readonly env: Record<string, string>;
  readonly #server: net.Server;
  readonly #dir: string;
  readonly #listeners = new Set<(prompting: boolean) => void>();
  #open = 0;

  private constructor(server: net.Server, dir: string, env: Record<string, string>) {
    this.#server = server;
    this.#dir = dir;
    this.env = env;
  }

  static async start(ask: Ask): Promise<Askpass> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'git-spark-'));
    const token = randomBytes(16).toString('hex');
    const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\git-spark-askpass-${token}` : path.join(dir, 'askpass.sock');
    const main = path.join(dir, 'askpass-main.cjs');
    const script = path.join(dir, 'askpass.sh');
    await writeFile(main, MAIN);
    await writeFile(script, SCRIPT, { mode: 0o755 });
    const queue = new Limiter(1); // une question à la fois
    let self: Askpass | undefined;
    const server = net.createServer((socket) => {
      let data = '';
      socket.setEncoding('utf8');
      socket.on('error', () => {});
      socket.on('data', (chunk: string) => {
        data += chunk;
        const end = data.indexOf('\n');
        if (end < 0) return;
        socket.removeAllListeners('data');
        let request: { token?: unknown; prompt?: unknown };
        try {
          request = JSON.parse(data.slice(0, end)) as typeof request;
        } catch {
          return void socket.end('{}');
        }
        if (request.token !== token) return void socket.end('{}');
        const prompt = typeof request.prompt === 'string' ? request.prompt : '';
        void queue
          .run(() => (self as Askpass).#ask(ask, prompt))
          .then(
            (value) => socket.end(JSON.stringify(value === undefined ? {} : { value })),
            () => socket.end('{}'),
          );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipe, () => {
        server.off('error', reject);
        resolve();
      });
    });
    self = new Askpass(server, dir, {
      GIT_ASKPASS: script,
      SSH_ASKPASS: script,
      // ssh passe par SSH_ASKPASS même s'il trouve un terminal (OpenSSH 8.4+).
      SSH_ASKPASS_REQUIRE: 'force',
      GIT_SPARK_ASKPASS_NODE: process.execPath,
      GIT_SPARK_ASKPASS_MAIN: main,
      GIT_SPARK_ASKPASS_PIPE: pipe,
      GIT_SPARK_ASKPASS_TOKEN: token,
    });
    return self;
  }

  get prompting(): boolean {
    return this.#open > 0;
  }

  onDidChangePrompting(listener: (prompting: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #ask(ask: Ask, prompt: string): Promise<string | undefined> {
    if (this.#open++ === 0) this.#emit(true);
    try {
      return await ask(prompt);
    } finally {
      if (--this.#open === 0) this.#emit(false);
    }
  }

  #emit(prompting: boolean): void {
    for (const listener of [...this.#listeners]) listener(prompting);
  }

  async dispose(): Promise<void> {
    this.#listeners.clear();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    await rm(this.#dir, { recursive: true, force: true });
  }
}
