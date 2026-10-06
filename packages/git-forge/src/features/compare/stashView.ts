// Vue « Stashes » : stashs du dépôt courant et leurs fichiers ; créer, appliquer, pop, supprimer, comparer un fichier.
import path from 'node:path';
import * as vscode from 'vscode';
import type { GitCommands, StashEntry, StashFile } from '../../git/commands.ts';
import type { Repos } from '../../git/repos.ts';
import { relativeTime } from '../../shared/dates.ts';
import { currentRoot } from '../../shared/pickRepo.ts';
import { revisionUri } from '../../shared/revisions.ts';
import { errorText } from '../merge/command.ts';

const REFRESH_DELAY = 300;

type Node = { type: 'stash'; root: string; stash: StashEntry } | { type: 'file'; root: string; stash: StashEntry; file: StashFile };

export class StashView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  readonly #git: GitCommands;
  readonly #repos: Repos;
  readonly #changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.#changed.event;
  readonly #view: vscode.TreeView<Node>;
  readonly #disposables: vscode.Disposable[];
  #root: string | undefined;
  #stashes: StashEntry[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Seul le dernier rafraîchissement lancé écrit son résultat. */
  #generation = 0;

  constructor(git: GitCommands, repos: Repos) {
    this.#git = git;
    this.#repos = repos;
    this.#view = vscode.window.createTreeView('gitForge.stashes', { treeDataProvider: this });
    const command = (id: string, run: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, run);
    this.#disposables = [
      this.#view,
      this.#changed,
      repos.onDidChange(() => this.#schedule()),
      vscode.window.onDidChangeActiveTextEditor(() => this.#schedule()),
      command('gitForge.stash.push', () => this.#pushInteractive()),
      command('gitForge.stash.apply', (node: Node) => this.apply(node, false)),
      command('gitForge.stash.pop', (node: Node) => this.apply(node, true)),
      command('gitForge.stash.drop', (node: Node) => this.#drop(node)),
    ];
    void this.refresh();
  }

  get root(): string | undefined {
    return this.#root;
  }

  /** Stashs affichés (tests e2e). */
  get stashes(): readonly StashEntry[] {
    return this.#stashes;
  }

  dispose(): void {
    clearTimeout(this.#timer);
    for (const disposable of this.#disposables) disposable.dispose();
  }

  async refresh(): Promise<void> {
    const generation = ++this.#generation;
    const root = currentRoot(this.#repos);
    let stashes: StashEntry[];
    try {
      stashes = root ? await this.#git.stashes(root) : [];
    } catch {
      stashes = [];
    }
    if (generation !== this.#generation) return;
    this.#root = root;
    this.#stashes = stashes;
    this.#view.description = root && this.#repos.roots().length > 1 ? path.basename(root) : undefined;
    this.#view.message = this.#stashes.length ? undefined : vscode.l10n.t('No stash.');
    this.#changed.fire(undefined);
  }

  /** Met de côté toutes les modifications, fichiers non suivis compris. */
  async push(root: string, message: string): Promise<void> {
    try {
      await this.#git.stashPush(root, message, true);
    } catch (err) {
      void vscode.window.showErrorMessage(errorText(err));
    }
    await this.refresh();
  }

  async apply(node: Node, pop: boolean): Promise<void> {
    try {
      const result = await this.#git.stashApply(node.root, node.stash, pop);
      if (result === 'applied-without-index') {
        void vscode.window.showWarningMessage(vscode.l10n.t('The stash was applied, but its staged changes could not be restored as staged: they are now unstaged.'));
      } else if (result === 'conflicts') {
        void vscode.window.showWarningMessage(vscode.l10n.t('The stash was applied with conflicts: resolve them in the Conflicts view. The stash was kept.'));
      }
    } catch (err) {
      void vscode.window.showErrorMessage(errorText(err));
    }
    await this.refresh();
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const root = this.#root;
    if (!root) return [];
    if (!node) return this.#stashes.map((stash) => ({ type: 'stash', root, stash }));
    if (node.type !== 'stash') return [];
    const files = await this.#git.stashFiles(node.root, node.stash).catch(() => []);
    return files.map((file) => ({ type: 'file', root: node.root, stash: node.stash, file }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === 'stash') {
      const { stash } = node;
      const item = new vscode.TreeItem(stash.message.replace(/^On [^:]+: /, ''), vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${stash.ref} · ${relativeTime(stash.time, Date.now(), vscode.env.language)}`;
      item.tooltip = stash.message;
      item.iconPath = new vscode.ThemeIcon('archive');
      item.contextValue = 'gitForge.stash';
      return item;
    }
    const { change, untracked } = node.file;
    const item = new vscode.TreeItem(path.posix.basename(change.path));
    const dir = path.posix.dirname(change.path);
    const status = untracked ? vscode.l10n.t('untracked') : change.status;
    item.description = dir === '.' ? status : `${dir} · ${status}`;
    item.resourceUri = vscode.Uri.file(path.join(node.root, change.path));
    const sha = node.stash.sha;
    const left = revisionUri({
      root: node.root,
      path: change.oldPath ?? change.path,
      sha: untracked || change.status === 'A' ? '' : `${sha}^1`,
    });
    const right = revisionUri({ root: node.root, path: change.path, sha: change.status === 'D' ? '' : untracked ? `${sha}^3` : sha });
    item.command = { command: 'vscode.diff', title: '', arguments: [left, right, `${path.posix.basename(change.path)} (${node.stash.ref})`] };
    return item;
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.refresh(), REFRESH_DELAY);
  }

  async #pushInteractive(): Promise<void> {
    const root = currentRoot(this.#repos);
    if (!root) return;
    const message = await vscode.window.showInputBox({
      title: vscode.l10n.t('Stash all changes (untracked files included)'),
      prompt: vscode.l10n.t('Stash message (optional)'),
    });
    if (message === undefined) return;
    await this.push(root, message || 'git-forge stash');
  }

  async #drop(node: Node): Promise<void> {
    const drop = vscode.l10n.t('Delete');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('Delete {0} ({1})? It cannot be recovered from the stash list.', node.stash.ref, node.stash.message),
      { modal: true },
      drop,
    );
    if (choice !== drop) return;
    try {
      await this.#git.stashDrop(node.root, node.stash);
    } catch (err) {
      void vscode.window.showErrorMessage(errorText(err));
    }
    await this.refresh();
  }
}
