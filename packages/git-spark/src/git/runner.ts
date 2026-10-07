// Exécution du binaire git : sortie complète, erreurs typées, annulation, et nombre de commandes simultanées limité par dépôt.
import { spawn, type ChildProcess } from 'node:child_process';

export interface RunOptions {
  /** Texte envoyé sur l'entrée standard. */
  input?: string;
  signal?: AbortSignal;
  env?: Record<string, string>;
  /** Délai maximal (commandes réseau) : au-delà, git est arrêté et la promesse rejetée avec TimeoutError. */
  timeoutMs?: number;
  /** Questions posées à l'utilisateur (passphrase…) : le délai maximal ne compte pas le temps passé à y répondre. */
  prompts?: PromptState;
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

/** Source qui signale si une question est affichée (les délais réseau s'arrêtent pendant ce temps). */
export interface PromptState {
  readonly prompting: boolean;
  /** Renvoie la fonction de désabonnement. */
  onDidChangePrompting(listener: (prompting: boolean) => void): () => void;
}

/**
 * Appelle `onTimeout` après `ms` millisecondes, sans compter le temps passé devant une question (passphrase…).
 * Renvoie la fonction qui arrête le délai.
 */
export function promptAwareTimeout(ms: number, onTimeout: () => void, state: PromptState | undefined): () => void {
  let remaining = ms;
  let started = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const run = () => {
    if (done || timer) return;
    started = Date.now();
    timer = setTimeout(() => {
      done = true;
      timer = undefined;
      onTimeout();
    }, Math.max(0, remaining));
  };
  const pause = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
    remaining -= Date.now() - started;
  };
  if (!state?.prompting) run();
  const off = state?.onDidChangePrompting((prompting) => (prompting ? pause() : run()));
  return () => {
    done = true;
    clearTimeout(timer);
    timer = undefined;
    off?.();
  };
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
      // Commande réseau : groupe de processus à part, pour arrêter aussi ssh à l'expiration du délai.
      detached: Boolean(options.timeoutMs) && process.platform !== 'win32',
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.stdin.on('error', () => {}); // git peut fermer son entrée avant de tout lire (EPIPE)
    let timedOut = false;
    const stopTimer = options.timeoutMs
      ? promptAwareTimeout(
          options.timeoutMs,
          () => {
            timedOut = true;
            killTree(child);
            // Sans attendre la fin des processus (un ssh bloqué garde les sorties ouvertes).
            reject(new TimeoutError(args, options.timeoutMs as number));
          },
          options.prompts,
        )
      : undefined;
    child.on('error', (error) => {
      stopTimer?.();
      reject(signal?.aborted ? new CancelledError() : error);
    });
    child.on('close', (code) => {
      stopTimer?.();
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

/** Arrête git et les processus qu'il a lancés (ssh…). */
function killTree(child: ChildProcess): void {
  const { pid } = child;
  try {
    if (pid === undefined) child.kill();
    else if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill());
    else process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill();
  }
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

  /** Questions de git et ssh posées à l'utilisateur (passphrase de clé SSH…) : environnement donné à chaque commande. */
  askpass: (PromptState & { readonly env: Record<string, string> }) | undefined;

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
    return this.#report(args, limiter(this.#reads, cwd, 4).run(() => runGit(this.gitPath, cwd, args, this.#withAskpass({ ...options, env }))));
  }

  write(cwd: string, args: string[], options?: RunOptions): Promise<RunResult> {
    return this.#report(args, limiter(this.#writes, cwd, 1).run(() => runGit(this.gitPath, cwd, args, this.#withAskpass(options))));
  }

  #withAskpass(options: RunOptions = {}): RunOptions {
    const askpass = this.askpass;
    return askpass ? { prompts: askpass, ...options, env: { ...askpass.env, ...options.env } } : options;
  }
}

function limiter(map: Map<string, Limiter>, key: string, max: number): Limiter {
  let found = map.get(key);
  if (!found) map.set(key, (found = new Limiter(max)));
  return found;
}
