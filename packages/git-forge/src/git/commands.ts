// Commandes Git typées : seul passage des fonctions (features/*) vers git.
import { parseBlameIncremental, type BlameResult } from './parsers/blame.ts';
import { GitError, type GitRunner } from './runner.ts';

/** Chemins affichés tels quels (accents, espaces), sans échappement. */
const RAW_PATHS = ['-c', 'core.quotePath=false'];

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
}
