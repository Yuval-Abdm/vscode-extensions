// Vue « Graph » du panneau du bas (conteneur Git Spark, à côté du Terminal) : une GraphSession sur le dépôt de l'éditeur
// actif, remplacée quand l'éditeur actif passe dans un autre dépôt. Compacte quand elle est étroite (déplacée dans la
// barre latérale), colonnes complètes sinon.
import * as vscode from 'vscode';
import type { GitCommands } from '../../git/commands.ts';
import type { Repos } from '../../git/repos.ts';
import { currentRoot } from '../../shared/pickRepo.ts';
import { GraphSession } from './session.ts';

export class GraphSidebar implements vscode.WebviewViewProvider, vscode.Disposable {
  readonly #git: GitCommands;
  readonly #repos: Repos;
  readonly #extensionUri: vscode.Uri;
  readonly #onOpenInEditor: (root: string) => void;
  #view: vscode.WebviewView | undefined;
  #session: GraphSession | undefined;
  readonly #disposables: vscode.Disposable[] = [];

  constructor(git: GitCommands, repos: Repos, extensionUri: vscode.Uri, onOpenInEditor: (root: string) => void) {
    this.#git = git;
    this.#repos = repos;
    this.#extensionUri = extensionUri;
    this.#onOpenInEditor = onOpenInEditor;
    this.#disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.#follow()),
      repos.onDidChange(() => {
        if (!this.#session) this.#follow();
      }),
    );
  }

  /** Session affichée (tests e2e, menus contextuels). */
  get session(): GraphSession | undefined {
    return this.#session;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view;
    // Masquée, la vue peut manquer des changements : relue à chaque affichage.
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.#session?.reloadIfChanged();
    });
    view.onDidDispose(() => {
      this.#session?.dispose();
      this.#session = undefined;
      this.#view = undefined;
    });
    this.#follow(true);
  }

  dispose(): void {
    this.#session?.dispose();
    for (const disposable of this.#disposables) disposable.dispose();
  }

  /** Session sur le dépôt courant ; recréée seulement si le dépôt change (ou à la demande). */
  #follow(force = false): void {
    const view = this.#view;
    const root = currentRoot(this.#repos);
    if (!view || !root || (!force && this.#session?.root === root)) return;
    this.#session?.dispose();
    this.#session = new GraphSession(this.#git, this.#repos, view.webview, root, this.#extensionUri, {
      sidebar: true,
      onOpenInEditor: () => this.#onOpenInEditor(root),
    });
    view.description = this.#repos.roots().length > 1 ? root.split(/[\\/]/).pop() : undefined;
  }
}
