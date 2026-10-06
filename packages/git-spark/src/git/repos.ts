// Dépôts ouverts, suivis via l'API vscode.git : dépôt d'un fichier et événement à chaque changement (HEAD, index, fichiers).
import * as vscode from 'vscode';
import type { API, Repository } from './gitApi.ts';
import type { RepoLocation, RepoLocator } from './locator.ts';

export class Repos implements RepoLocator, vscode.Disposable {
  readonly #api: API;
  readonly #changed = new vscode.EventEmitter<Repository>();
  readonly onDidChange = this.#changed.event;
  readonly #disposables: vscode.Disposable[] = [this.#changed];

  /** Écoute de chaque dépôt ouvert, retirée à sa fermeture. */
  readonly #watched = new Map<Repository, vscode.Disposable>();

  constructor(api: API) {
    this.#api = api;
    const watch = (repo: Repository) => {
      if (!this.#watched.has(repo)) this.#watched.set(repo, repo.state.onDidChange(() => this.#changed.fire(repo)));
    };
    api.repositories.forEach(watch);
    this.#disposables.push(
      api.onDidOpenRepository(watch),
      api.onDidCloseRepository((repo) => {
        this.#watched.get(repo)?.dispose();
        this.#watched.delete(repo);
        this.#changed.fire(repo);
      }),
    );
  }

  locate(fileName: string): RepoLocation | undefined {
    const repo = this.#api.getRepository(vscode.Uri.file(fileName));
    return repo ? { root: repo.rootUri.fsPath, head: repo.state.HEAD?.commit } : undefined;
  }

  /** Racines des dépôts ouverts. */
  roots(): string[] {
    return this.#api.repositories.map((repo) => repo.rootUri.fsPath);
  }

  dispose(): void {
    for (const disposable of this.#watched.values()) disposable.dispose();
    for (const disposable of this.#disposables) disposable.dispose();
  }
}
