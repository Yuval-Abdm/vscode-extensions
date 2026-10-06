// Commandes Git typées : seul passage des fonctions (features/*) vers git.
import { parseBlameIncremental, type BlameResult } from './parsers/blame.ts';
import { LOG_FORMAT, parseHunks, parseLog, parseNameStatus, type FileChange, type Hunk, type LogEntry } from './parsers/log.ts';
import { GitError, type GitRunner } from './runner.ts';

/** Chemins affichés tels quels (accents, espaces), sans échappement. */
const RAW_PATHS = ['-c', 'core.quotePath=false'];

/** Format de log stable quelle que soit la configuration de l'utilisateur (couleurs, signatures, log.showRoot). */
const LOG = [...RAW_PATHS, 'log', '--no-color', '--no-show-signature', '--root', `--format=${LOG_FORMAT}`];

/** Page d'un historique. */
export interface Page {
  skip?: number;
  limit?: number;
  signal?: AbortSignal;
}

function pageArgs(page: Page): string[] {
  return [`--skip=${page.skip ?? 0}`, `--max-count=${page.limit ?? 50}`];
}

export class GitCommands {
  readonly runner: GitRunner;

  constructor(runner: GitRunner) {
    this.runner = runner;
  }

  /** Blame de `relPath` (relatif à `root`, séparateurs `/`), sur `contents` s'il est donné (contenu de l'éditeur). */
  async blame(root: string, relPath: string, options: { contents?: string; signal?: AbortSignal } = {}): Promise<BlameResult> {
    const args = [...RAW_PATHS, 'blame', '--incremental'];
    if (options.contents !== undefined) args.push('--contents', '-');
    args.push('--', relPath);
    const { stdout } = await this.runner.read(root, args, { input: options.contents, signal: options.signal });
    return parseBlameIncremental(stdout);
  }

  /** Contenu de `relPath` au commit `sha`. */
  async show(root: string, sha: string, relPath: string): Promise<string> {
    return (await this.runner.read(root, [...RAW_PATHS, 'show', `${sha}:${relPath}`])).stdout;
  }

  /** Message complet d'un commit, sans le saut de ligne final. */
  async message(root: string, sha: string): Promise<string> {
    return (await this.runner.read(root, ['show', '-s', '--format=%B', sha])).stdout.trimEnd();
  }

  /** SHA de HEAD, ou undefined dans un dépôt sans commit. */
  async head(root: string): Promise<string | undefined> {
    try {
      return (await this.runner.read(root, ['rev-parse', '--verify', '-q', 'HEAD'])).stdout.trim() || undefined;
    } catch (err) {
      if (err instanceof GitError) return undefined;
      throw err;
    }
  }

  /** Commits qui ont modifié `relPath`, du plus récent au plus ancien, en suivant les renommages. */
  async fileHistory(root: string, relPath: string, page: Page = {}): Promise<LogEntry[]> {
    // --follow filtre après le parcours : --skip compterait aussi les commits qui ne touchent pas le fichier.
    // On demande donc skip + limit commits et on retire les premiers. --cc : merges qui modifient le fichier.
    const skip = page.skip ?? 0;
    const args = [...LOG, '--follow', '-M', '--cc', '--name-status', `--max-count=${skip + (page.limit ?? 50)}`, '--', relPath];
    return parseLog((await this.runner.read(root, args, { signal: page.signal })).stdout).slice(skip);
  }

  /** Commits qui ont modifié les lignes `start` à `end` (1-based, incluses) de `relPath`. */
  async lineHistory(root: string, relPath: string, start: number, end: number, page: Page = {}): Promise<LogEntry[]> {
    const args = [...LOG, '-M', '--src-prefix=a/', '--dst-prefix=b/', `-L${start},${end}:${relPath}`, ...pageArgs(page)];
    return parseLog((await this.runner.read(root, args, { signal: page.signal })).stdout);
  }

  /** Blocs modifiés entre `relPath` à HEAD et `contents` (contenu de l'éditeur). */
  async diffHead(root: string, relPath: string, contents: string): Promise<Hunk[]> {
    const blob = (await this.runner.write(root, ['hash-object', '-w', '--stdin', `--path=${relPath}`], { input: contents })).stdout.trim();
    const { stdout } = await this.runner.read(root, ['diff', '--no-color', '--no-ext-diff', '-U0', `HEAD:${relPath}`, blob]);
    return parseHunks(stdout);
  }

  /** Fichiers modifiés par `sha` par rapport à `parent` (tous les fichiers ajoutés pour un commit racine). */
  async commitFiles(root: string, sha: string, parent?: string): Promise<FileChange[]> {
    const args = parent
      ? [...RAW_PATHS, 'diff', '--no-color', '--name-status', '-M', parent, sha]
      : [...RAW_PATHS, 'diff-tree', '--no-color', '--root', '--no-commit-id', '-r', '--name-status', '-M', sha];
    return parseNameStatus((await this.runner.read(root, args)).stdout);
  }
}
