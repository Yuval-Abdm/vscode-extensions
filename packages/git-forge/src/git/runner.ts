// Exécution du binaire git : sortie complète, erreurs typées, annulation, et nombre de commandes simultanées limité par dépôt.
import { spawn } from 'node:child_process';

export interface RunOptions {
  /** Texte envoyé sur l'entrée standard. */
  input?: string;
  signal?: AbortSignal;
  env?: Record<string, string>;
  /** Délai maximal (commandes réseau) : au-delà, git est arrêté et la promesse rejetée avec TimeoutError. */
  timeoutMs?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** git s'est terminé avec un code de sortie non nul. */
export class GitError extends Error {
  readonly args: string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;

  constructor(args: string[], exitCode: number | null, stderr: string, stdout = '') {
    super(`git ${args.join(' ')} (${exitCode}): ${stderr.trim()}`);
    this.name = 'GitError';
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.stdout = stdout;
  }
}

/** La commande a dépassé son délai maximal (réseau bloqué, demande d'identifiants sans réponse…). */
export class TimeoutError extends Error {
  readonly args: string[];

  constructor(args: string[], timeoutMs: number) {
    super(`git ${args.join(' ')}: no answer after ${Math.round(timeoutMs / 1000)} s`);
    this.name = 'TimeoutError';
    this.args = args;
  }
}

/** La commande a été annulée par son AbortSignal. */
export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export function runGit(gitPath: string, cwd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const { signal } = options;
    if (signal?.aborted) return reject(new CancelledError());
    const child = spawn(gitPath, args, {
      cwd,
      // Chemins toujours pris littéralement (pas de glob ni de « :magie » dans un nom de fichier).
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C', ...options.env },
      signal,
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.stdin.on('error', () => {}); // git peut fermer son entrée avant de tout lire (EPIPE)
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeoutMs)
      : undefined;
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(signal?.aborted ? new CancelledError() : error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal?.aborted) return reject(new CancelledError());
      if (timedOut) return reject(new TimeoutError(args, options.timeoutMs as number));
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) resolve({ stdout, stderr });
      else reject(new GitError(args, code, stderr, stdout));
    });
    child.stdin.end(options.input ?? '');
  });
}

/** Limite le nombre de tâches simultanées ; les suivantes attendent leur tour (ordre d'arrivée). */
export class Limiter {
  readonly #max: number;
  #running = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(max: number) {
    this.#max = max;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#running < this.#max) this.#running++;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve)); // place transmise par la tâche qui se termine
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#running--;
    }
  }
}

/** Exécute git dans un dépôt : 4 lectures simultanées au plus, une seule écriture à la fois. */
export class GitRunner {
  readonly gitPath: string;
  readonly #reads = new Map<string, Limiter>();
  readonly #writes = new Map<string, Limiter>();

  constructor(gitPath: string) {
    this.gitPath = gitPath;
  }

  /** Appelé pour chaque commande en échec (canal de sortie « Git Spark »). */
  onFailure: ((args: string[], stderr: string) => void) | undefined;

  #report<T>(args: string[], pending: Promise<T>): Promise<T> {
    return pending.catch((err: unknown) => {
      if (err instanceof GitError) this.onFailure?.(args, err.stderr);
      else if (err instanceof TimeoutError || (err instanceof Error && !(err instanceof CancelledError))) this.onFailure?.(args, err.message);
      throw err;
    });
  }

  read(cwd: string, args: string[], options?: RunOptions): Promise<RunResult> {
    // Lecture en arrière-plan : pas de verrou index.lock pris par git status pendant que l'utilisateur travaille.
    const env = { GIT_OPTIONAL_LOCKS: '0', ...options?.env };
    return this.#report(args, limiter(this.#reads, cwd, 4).run(() => runGit(this.gitPath, cwd, args, { ...options, env })));
  }

  write(cwd: string, args: string[], options?: RunOptions): Promise<RunResult> {
    return this.#report(args, limiter(this.#writes, cwd, 1).run(() => runGit(this.gitPath, cwd, args, options)));
  }
}

function limiter(map: Map<string, Limiter>, key: string, max: number): Limiter {
  let found = map.get(key);
  if (!found) map.set(key, (found = new Limiter(max)));
  return found;
}
