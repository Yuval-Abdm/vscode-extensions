// Commandes Git typées : seul passage des fonctions (features/*) vers git.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseBlameIncremental, type BlameResult } from './parsers/blame.ts';
import { LOG_FORMAT, parseHunks, parseLog, parseNameStatus, type FileChange, type Hunk, type LogEntry } from './parsers/log.ts';
import { parseStatusV2, type Status } from './parsers/status.ts';
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

/** Aucune commande d'écriture n'ouvre d'éditeur. */
const NO_EDITOR = { GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', GIT_SEQUENCE_EDITOR: 'true' };

export interface LocalBranch {
  name: string;
  sha: string;
  upstream?: {
    /** Nom court (`origin/main`). */
    name: string;
    remote: string;
    /** Référence sur le remote (`refs/heads/main`). */
    ref: string;
  };
}

export type OperationKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

export interface Operation {
  kind: OperationKind;
  /** Merge : première ligne de MERGE_MSG ; rebase : branche rebasée. */
  label?: string;
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

  async status(root: string): Promise<Status> {
    const args = ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no'];
    return parseStatusV2((await this.runner.read(root, args)).stdout);
  }

  async branches(root: string): Promise<LocalBranch[]> {
    const format = '%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)';
    const { stdout } = await this.runner.read(root, ['for-each-ref', `--format=${format}`, 'refs/heads']);
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, sha, upstream, remote, ref] = line.split('\0');
        return upstream && remote && ref ? { name, sha, upstream: { name: upstream, remote, ref } } : { name, sha };
      });
  }

  async remotes(root: string): Promise<string[]> {
    return (await this.runner.read(root, ['remote'])).stdout.split('\n').filter(Boolean);
  }

  /** SHA du commit désigné par `ref`, ou undefined s'il n'existe pas. */
  async revParse(root: string, ref: string): Promise<string | undefined> {
    try {
      return (await this.runner.read(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])).stdout.trim() || undefined;
    } catch (err) {
      if (err instanceof GitError) return undefined;
      throw err;
    }
  }

  async isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.runner.read(root, ['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch (err) {
      if (err instanceof GitError && err.exitCode === 1) return false;
      throw err;
    }
  }

  /** Opération en cours (merge, rebase, cherry-pick, revert), lue dans le dossier .git. */
  async operation(root: string): Promise<Operation | undefined> {
    const gitDir = (await this.runner.read(root, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
    const at = (name: string) => path.join(gitDir, name);
    const firstLine = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n')[0].trim() : '') || undefined;
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      if (existsSync(at(dir)) && !existsSync(at(`${dir}/applying`))) {
        return { kind: 'rebase', label: firstLine(at(`${dir}/head-name`))?.replace(/^refs\/heads\//, '') };
      }
    }
    if (existsSync(at('MERGE_HEAD'))) return { kind: 'merge', label: firstLine(at('MERGE_MSG')) };
    if (existsSync(at('CHERRY_PICK_HEAD'))) return { kind: 'cherry-pick' };
    if (existsSync(at('REVERT_HEAD'))) return { kind: 'revert' };
    return undefined;
  }

  async fetchAll(root: string): Promise<void> {
    await this.runner.write(root, ['fetch', '--all', '--quiet']);
  }

  async checkout(root: string, branch: string): Promise<void> {
    await this.runner.write(root, ['checkout', '--quiet', branch]);
  }

  /** Avance la branche courante jusqu'à `ref`, seulement en fast-forward. */
  async fastForward(root: string, ref: string): Promise<void> {
    await this.runner.write(root, ['merge', '--ff-only', '--quiet', ref], { env: NO_EDITOR });
  }

  /** Déplace une branche non extraite de `oldSha` à `sha` (refusé si elle a bougé entre-temps). */
  async updateBranch(root: string, branch: string, sha: string, oldSha: string): Promise<void> {
    await this.runner.write(root, ['update-ref', '-m', 'git-forge: fast-forward', `refs/heads/${branch}`, sha, oldSha]);
  }

  async merge(root: string, source: string, options: { noFf: boolean }): Promise<'merged' | 'up-to-date' | 'conflicts'> {
    const args = ['merge', '--no-edit', ...(options.noFf ? ['--no-ff'] : []), source];
    try {
      const { stdout } = await this.runner.write(root, args, { env: NO_EDITOR });
      return /Already up to date/i.test(stdout) ? 'up-to-date' : 'merged';
    } catch (err) {
      if (err instanceof GitError && err.exitCode === 1 && (await this.status(root)).conflicts.length) return 'conflicts';
      throw err;
    }
  }

  /** Supprime une branche locale déjà mergée (`git branch -d`). */
  async deleteBranch(root: string, name: string): Promise<void> {
    await this.runner.write(root, ['branch', '-d', name]);
  }

  async pushDelete(root: string, remote: string, branch: string): Promise<void> {
    await this.runner.write(root, ['push', '--quiet', remote, '--delete', branch]);
  }

  async push(root: string): Promise<void> {
    await this.runner.write(root, ['push', '--quiet']);
  }

  async stashPush(root: string, message: string): Promise<void> {
    await this.runner.write(root, ['stash', 'push', '--quiet', '-m', message]);
  }

  /** Remplace un fichier en conflit par sa version « mienne » ou « leur ». */
  async checkoutSide(root: string, relPath: string, side: 'ours' | 'theirs'): Promise<void> {
    await this.runner.write(root, ['checkout', `--${side}`, '--', relPath]);
  }

  async add(root: string, relPath: string): Promise<void> {
    await this.runner.write(root, ['add', '--', relPath]);
  }

  async remove(root: string, relPath: string): Promise<void> {
    await this.runner.write(root, ['rm', '--quiet', '--', relPath]);
  }

  /** Termine l'opération : commit du merge, ou `--continue`. */
  async continueOperation(root: string, kind: OperationKind): Promise<void> {
    const args = kind === 'merge' ? ['commit', '--no-edit', '--quiet'] : [kind, '--continue'];
    await this.runner.write(root, args, { env: NO_EDITOR });
  }

  async abortOperation(root: string, kind: OperationKind): Promise<void> {
    await this.runner.write(root, [kind, '--abort'], { env: NO_EDITOR });
  }
}
