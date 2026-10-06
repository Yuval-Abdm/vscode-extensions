// Vue « Worktrees » : worktrees du dépôt courant ; créer depuis une branche (existante ou nouvelle), ouvrir dans une
// nouvelle fenêtre, supprimer.
import path from 'node:path';
import * as vscode from 'vscode';
import type { GitCommands, Worktree } from '../../git/commands.ts';
import type { Repos } from '../../git/repos.ts';
import { GitError } from '../../git/runner.ts';
import { currentRoot } from '../../shared/pickRepo.ts';
import { errorText } from '../merge/command.ts';

const REFRESH_DELAY = 300;

type Node = { root: string; worktree: Worktree; current: boolean };

export class WorktreeView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  readonly #git: GitCommands;
  readonly #repos: Repos;
  readonly #changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.#changed.event;
  readonly #view: vscode.TreeView<Node>;
  readonly #disposables: vscode.Disposable[];
  #root: string | undefined;
  #worktrees: Worktree[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(git: GitCommands, repos: Repos) {
    this.#git = git;
    this.#repos = repos;
    this.#view = vscode.window.createTreeView('gitForge.worktrees', { treeDataProvider: this });
    const command = (id: string, run: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, run);
    this.#disposables = [
      this.#view,
      this.#changed,
      repos.onDidChange(() => this.#schedule()),
      vscode.window.onDidChangeActiveTextEditor(() => this.#schedule()),
      command('gitForge.worktree.add', () => this.#add()),
      command('gitForge.worktree.open', (node: Node) =>
        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.worktree.path), { forceNewWindow: true }),
      ),
      command('gitForge.worktree.remove', (node: Node) => this.#remove(node)),
    ];
    void this.refresh();
  }

  /** Worktrees affichés (tests e2e). */
  get worktrees(): readonly Worktree[] {
    return this.#worktrees;
  }

  dispose(): void {
    clearTimeout(this.#timer);
    for (const disposable of this.#disposables) disposable.dispose();
  }

  async refresh(): Promise<void> {
    const root = currentRoot(this.#repos);
    this.#root = root;
    try {
      this.#worktrees = root ? await this.#git.worktrees(root) : [];
    } catch {
      this.#worktrees = [];
    }
    if (this.#root !== root) return;
    this.#view.description = root && this.#repos.roots().length > 1 ? path.basename(root) : undefined;
    this.#changed.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    const root = this.#root;
    if (node || !root) return [];
    return this.#worktrees.map((worktree) => ({ root, worktree, current: samePath(worktree.path, root) }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const { worktree } = node;
    const label = worktree.branch ?? (worktree.bare ? vscode.l10n.t('bare repository') : vscode.l10n.t('detached at {0}', (worktree.head ?? '').slice(0, 8)));
    const item = new vscode.TreeItem(label);
    item.description = worktree.path;
    item.tooltip = [worktree.path, worktree.locked ? vscode.l10n.t('locked') : '', worktree.prunable ? vscode.l10n.t('folder missing') : '']
      .filter(Boolean)
      .join(' · ');
    item.iconPath = new vscode.ThemeIcon(node.current ? 'folder-active' : worktree.prunable ? 'warning' : 'folder');
    item.contextValue = node.current || worktree.bare ? 'gitForge.worktree.current' : 'gitForge.worktree';
    return item;
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.refresh(), REFRESH_DELAY);
  }

  async #add(): Promise<void> {
    const root = currentRoot(this.#repos);
    if (!root) return;
    const used = new Set(this.#worktrees.map((w) => w.branch).filter(Boolean));
    const branches = (await this.#git.branches(root)).filter((b) => !used.has(b.name));
    const create = { label: `$(add) ${vscode.l10n.t('New branch…')}`, branch: undefined as string | undefined };
    const picked = await vscode.window.showQuickPick([create, ...branches.map((b) => ({ label: `$(git-branch) ${b.name}`, branch: b.name as string | undefined }))], {
      title: vscode.l10n.t('New worktree: branch'),
    });
    if (!picked) return;
    let branch = picked.branch;
    const isNew = branch === undefined;
    if (isNew) {
      branch = await vscode.window.showInputBox({
        title: vscode.l10n.t('New worktree: name of the new branch'),
        validateInput: (value) => (/^[^\s~^:?*[\\]+$/.test(value) ? undefined : vscode.l10n.t('Invalid branch name.')),
      });
      if (!branch) return;
    }
    const name = branch as string;
    const dir = await vscode.window.showInputBox({
      title: vscode.l10n.t('New worktree: folder'),
      value: path.join(path.dirname(root), `${path.basename(root)}-${name.replace(/[\\/]/g, '-')}`),
    });
    if (!dir) return;
    try {
      await this.#git.worktreeAdd(root, dir, name, isNew);
    } catch (err) {
      void vscode.window.showErrorMessage(errorText(err));
      return;
    }
    await this.refresh();
    const open = vscode.l10n.t('Open in New Window');
    void vscode.window.showInformationMessage(vscode.l10n.t('Worktree created in {0}.', dir), open).then((choice) => {
      if (choice === open) void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir), { forceNewWindow: true });
    });
  }

  async #remove(node: Node): Promise<void> {
    const remove = vscode.l10n.t('Remove');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('Remove the worktree {0}? Its folder is deleted; the branch is kept.', node.worktree.path),
      { modal: true },
      remove,
    );
    if (choice !== remove) return;
    try {
      await this.#git.worktreeRemove(node.root, node.worktree.path, false);
    } catch (err) {
      if (!(err instanceof GitError)) throw err;
      const force = vscode.l10n.t('Remove Anyway');
      const again = await vscode.window.showWarningMessage(
        vscode.l10n.t('The worktree has changes or untracked files: {0}. Remove it anyway? Those changes are lost.', errorText(err)),
        { modal: true },
        force,
      );
      if (again !== force) return;
      try {
        await this.#git.worktreeRemove(node.root, node.worktree.path, true);
      } catch (error) {
        void vscode.window.showErrorMessage(errorText(error));
      }
    }
    await this.refresh();
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}
