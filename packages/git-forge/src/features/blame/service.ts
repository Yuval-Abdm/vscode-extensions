// Blame des documents ouverts, mis en cache par (fichier, HEAD, version du document). Sans dépendance à VS Code.
import path from 'node:path';
import { Lru } from '../../git/cache.ts';
import type { GitCommands } from '../../git/commands.ts';
import type { RepoLocator } from '../../git/locator.ts';
import { isUncommitted, type BlameCommit, type BlameResult } from '../../git/parsers/blame.ts';
import { CancelledError } from '../../git/runner.ts';

/** Ce que le service lit d'un document (vscode.TextDocument convient). */
export interface BlameDocument {
  readonly fileName: string;
  readonly version: number;
  readonly lineCount: number;
  getText(): string;
}

export interface FileBlame {
  root: string;
  relPath: string;
  head: string;
  result: BlameResult;
}

export interface LineInfo {
  root: string;
  relPath: string;
  head: string;
  commit: BlameCommit;
  uncommitted: boolean;
}

/** Chemin relatif à la racine du dépôt, séparateurs `/`. */
export function relativePath(root: string, fileName: string): string {
  return path.relative(root, fileName).split(path.sep).join('/');
}

export class BlameService {
  readonly #git: GitCommands;
  readonly #repos: RepoLocator;
  readonly #maxLines: () => number;
  readonly #blames = new Lru<string, Promise<FileBlame | undefined>>(50);
  readonly #messages = new Lru<string, Promise<string>>(200);

  constructor(git: GitCommands, repos: RepoLocator, maxLines: () => number) {
    this.#git = git;
    this.#repos = repos;
    this.#maxLines = maxLines;
  }

  /** HEAD du dépôt du fichier (pour savoir si un blame affiché est périmé). */
  head(fileName: string): string | undefined {
    return this.#repos.locate(fileName)?.head;
  }

  /**
   * Blame du document, sur son contenu actuel. undefined si le fichier n'a pas de blame (hors dépôt, non suivi,
   * dépôt sans commit, trop long). Rejette avec CancelledError si `signal` est annulé.
   */
  async fileBlame(doc: BlameDocument, signal?: AbortSignal): Promise<FileBlame | undefined> {
    const location = this.#repos.locate(doc.fileName);
    if (!location || location.head === undefined || doc.lineCount > this.#maxLines()) return undefined;
    const { root, head } = location;
    const relPath = relativePath(root, doc.fileName);
    const key = [root, relPath, head, doc.version].join('\0');
    for (let attempt = 0; ; attempt++) {
      let pending = this.#blames.get(key);
      if (!pending) {
        const started: Promise<FileBlame | undefined> = this.#git.blame(root, relPath, { contents: doc.getText(), signal }).then(
          (result) => ({ root, relPath, head, result }),
          (err) => {
            if (err instanceof CancelledError) throw err;
            return undefined; // non suivi, ignoré… : pas de blame
          },
        );
        // Un calcul annulé ne reste pas en cache.
        started.catch(() => {
          if (this.#blames.get(key) === started) this.#blames.delete(key);
        });
        this.#blames.set(key, started);
        pending = started;
      }
      try {
        return await pending;
      } catch (err) {
        // Calcul partagé annulé par un autre appelant : on relance une fois pour soi.
        if (!(err instanceof CancelledError) || signal?.aborted || attempt > 0) throw err;
      }
    }
  }

  async lineInfo(doc: BlameDocument, line: number, signal?: AbortSignal): Promise<LineInfo | undefined> {
    const blame = await this.fileBlame(doc, signal);
    const sha = blame?.result.lines[line];
    const commit = sha === undefined ? undefined : blame?.result.commits.get(sha);
    if (!blame || !sha || !commit) return undefined;
    return { root: blame.root, relPath: blame.relPath, head: blame.head, commit, uncommitted: isUncommitted(sha) };
  }

  /** Message complet d'un commit (le blame ne donne que la première ligne). */
  message(root: string, sha: string): Promise<string> {
    const key = `${root}\0${sha}`;
    let pending = this.#messages.get(key);
    if (!pending) {
      pending = this.#git.message(root, sha);
      pending.catch(() => this.#messages.delete(key));
      this.#messages.set(key, pending);
    }
    return pending;
  }

  clear(): void {
    this.#blames.clear();
    this.#messages.clear();
  }
}
