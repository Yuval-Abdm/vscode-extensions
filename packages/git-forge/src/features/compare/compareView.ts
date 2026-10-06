// Vue « Compare » : deux références (ou une référence et l'arbre de travail), depuis l'ancêtre commun ou directement ;
// commits et arbre des fichiers modifiés ; diff au clic ; déploiement des fichiers via FTP SFTP Deploy.
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { CompareMode, GitCommands } from '../../git/commands.ts';
import type { FileChange, LogEntry } from '../../git/parsers/log.ts';
import type { Repos } from '../../git/repos.ts';
import { relativeTime } from '../../shared/dates.ts';
import { deployApi, deployInstalled } from '../../shared/deploy.ts';
import { pickRef } from '../../shared/pickRef.ts';
import { pickRepo } from '../../shared/pickRepo.ts';
import { revisionUri } from '../../shared/revisions.ts';
import { errorText } from '../../shared/errors.ts';
import { buildFileTree, diffSides, type FolderEntry, type TreeEntry } from './model.ts';

export interface CompareSpec {
  root: string;
  left: string;
  /** undefined : l'arbre de travail. */
  right?: string;
  mode: CompareMode;
}

export interface CompareResult {
  base: string;
  rightSha?: string;
  changes: FileChange[];
  commits: LogEntry[];
}

type Node =
  | { type: 'group'; group: 'commits' | 'files' }
  | { type: 'commit'; entry: LogEntry }
  | { type: 'folder'; folder: FolderEntry }
  | { type: 'file'; change: FileChange };

export class CompareView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  readonly #git: GitCommands;
  readonly #repos: Repos;
  readonly #changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.#changed.event;
  readonly #view: vscode.TreeView<Node>;
  readonly #disposables: vscode.Disposable[];
  #spec: CompareSpec | undefined;
  #result: CompareResult | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(git: GitCommands, repos: Repos) {
    this.#git = git;
    this.#repos = repos;
    this.#view = vscode.window.createTreeView('gitForge.compare', { treeDataProvider: this, showCollapseAll: true });
    this.#view.message = vscode.l10n.t('Choose two references to compare.');
    void vscode.commands.executeCommand('setContext', 'gitForge.deployAvailable', deployInstalled());
    const command = (id: string, run: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, run);
    this.#disposables = [
      this.#view,
      this.#changed,
      vscode.extensions.onDidChange(() => vscode.commands.executeCommand('setContext', 'gitForge.deployAvailable', deployInstalled())),
      // Nouveau commit, checkout, fichier modifié : la comparaison affichée est recalculée.
      repos.onDidChange(() => {
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => {
          if (this.#spec) void this.compare(this.#spec);
        }, 500);
      }),
      command('gitForge.compareReferences', () => this.pick()),
      command('gitForge.compare.show', (spec: CompareSpec) => this.compare(spec)),
      command('gitForge.compare.swap', () => {
        const spec = this.#spec;
        if (spec?.right !== undefined) return this.compare({ ...spec, left: spec.right, right: spec.left });
      }),
      command('gitForge.compare.toggleMode', () => {
        const spec = this.#spec;
        if (spec) return this.compare({ ...spec, mode: spec.mode === 'merge-base' ? 'direct' : 'merge-base' });
      }),
      command('gitForge.compare.clear', () => this.#clear()),
      command('gitForge.compare.deploy', () => this.#deploy()),
    ];
  }

  get spec(): CompareSpec | undefined {
    return this.#spec;
  }

  /** Résultat affiché (tests e2e). */
  get result(): CompareResult | undefined {
    return this.#result;
  }

  dispose(): void {
    clearTimeout(this.#timer);
    void vscode.commands.executeCommand('setContext', 'gitForge.compare.active', false);
    for (const disposable of this.#disposables) disposable.dispose();
  }

  async pick(): Promise<void> {
    const root = await pickRepo(this.#repos);
    if (!root) return;
    const left = await pickRef(this.#git, root, vscode.l10n.t('Compare: base (left side)'), false);
    if (!left) return;
    const right = await pickRef(this.#git, root, vscode.l10n.t('Compare {0} with…', left), true);
    if (right === undefined) return;
    await this.compare({ root, left, right: right || undefined, mode: 'merge-base' });
    await vscode.commands.executeCommand('gitForge.compare.focus');
  }

  async compare(spec: CompareSpec): Promise<void> {
    this.#spec = spec;
    const separator = spec.mode === 'merge-base' ? '...' : '..';
    this.#view.description = `${shortRef(spec.left)} ${separator} ${spec.right === undefined ? vscode.l10n.t('working tree') : shortRef(spec.right)}`;
    void vscode.commands.executeCommand('setContext', 'gitForge.compare.hasRight', spec.right !== undefined);
    try {
      const [files, commits, rightSha] = await Promise.all([
        this.#git.compareFiles(spec.root, spec.left, spec.right, spec.mode),
        this.#git.commitsBetween(spec.root, spec.left, spec.right),
        spec.right === undefined ? Promise.resolve(undefined) : this.#git.revParse(spec.root, spec.right),
      ]);
      if (this.#spec !== spec) return;
      this.#result = { base: files.base, rightSha, changes: files.changes, commits };
      this.#view.message = files.changes.length ? undefined : vscode.l10n.t('No differences.');
    } catch (err) {
      if (this.#spec !== spec) return;
      this.#result = undefined;
      this.#view.message = vscode.l10n.t('Comparison failed: {0}', errorText(err));
    }
    void vscode.commands.executeCommand('setContext', 'gitForge.compare.active', true);
    this.#changed.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    const result = this.#result;
    if (!result) return [];
    if (!node) return [{ type: 'group', group: 'commits' }, { type: 'group', group: 'files' }];
    if (node.type === 'group') {
      return node.group === 'commits' ? result.commits.map((entry) => ({ type: 'commit', entry })) : toNodes(buildFileTree(result.changes));
    }
    if (node.type === 'folder') return toNodes(node.folder.children);
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const spec = this.#spec as CompareSpec;
    const result = this.#result as CompareResult;
    if (node.type === 'group') {
      const commits = node.group === 'commits';
      const item = new vscode.TreeItem(
        commits ? vscode.l10n.t('Commits ({0})', result.commits.length) : vscode.l10n.t('Files ({0})', result.changes.length),
        commits ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon(commits ? 'git-commit' : 'files');
      return item;
    }
    if (node.type === 'commit') {
      const { entry } = node;
      const item = new vscode.TreeItem(entry.summary || entry.sha.slice(0, 8));
      item.description = `${entry.author}, ${relativeTime(entry.authorTime, Date.now(), vscode.env.language)}`;
      item.tooltip = `${entry.sha.slice(0, 8)} · ${entry.summary}`;
      item.iconPath = new vscode.ThemeIcon(entry.parents.length > 1 ? 'git-merge' : 'git-commit');
      return item;
    }
    if (node.type === 'folder') {
      const item = new vscode.TreeItem(node.folder.name, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = vscode.ThemeIcon.Folder;
      item.resourceUri = vscode.Uri.file(path.join(spec.root, node.folder.path));
      return item;
    }
    const { change } = node;
    const item = new vscode.TreeItem(path.posix.basename(change.path));
    item.description = change.oldPath ? `${change.status} ← ${change.oldPath}` : change.status;
    item.resourceUri = vscode.Uri.file(path.join(spec.root, change.path));
    item.contextValue = 'gitForge.compareFile';
    const sides = diffSides(spec.root, result.base, result.rightSha, change);
    const left = revisionUri(sides.left);
    const right = sides.right === 'worktree' ? vscode.Uri.file(path.join(spec.root, change.path)) : revisionUri(sides.right);
    const title = `${path.posix.basename(change.path)} (${shortRef(spec.left)} ↔ ${spec.right === undefined ? vscode.l10n.t('working tree') : shortRef(spec.right)})`;
    item.command = { command: 'vscode.diff', title: '', arguments: [left, right, title] };
    return item;
  }

  #clear(): void {
    this.#spec = undefined;
    this.#result = undefined;
    this.#view.description = undefined;
    this.#view.message = vscode.l10n.t('Choose two references to compare.');
    void vscode.commands.executeCommand('setContext', 'gitForge.compare.active', false);
    this.#changed.fire(undefined);
  }

  async #deploy(): Promise<void> {
    const spec = this.#spec;
    if (!spec) return;
    // Liste recalculée : le dépôt a pu changer depuis l'affichage.
    await this.compare(spec);
    const result = this.#result;
    if (!result || this.#spec !== spec) return;
    const api = await deployApi();
    if (!api) return;
    if (!api.hasConfig()) {
      void vscode.window.showWarningMessage(vscode.l10n.t('No FTP SFTP Deploy profile is configured in this workspace.'));
      return;
    }
    const files = result.changes.filter((change) => change.status !== 'D').map((change) => vscode.Uri.file(path.join(spec.root, change.path)));
    const present = files.filter((uri) => existsSync(uri.fsPath));
    const deleted = result.changes.length - present.length;
    const renamed = result.changes.filter((change) => change.oldPath && change.status === 'R').map((change) => change.oldPath as string);
    const targets = api.resolve(present);
    const skipped = present.length - targets.length;
    if (!targets.length) {
      void vscode.window.showInformationMessage(vscode.l10n.t('No file to deploy (deleted files are never sent).'));
      return;
    }
    const hosts = [...new Set(targets.map((target) => target.host))].join(', ');
    const upload = vscode.l10n.t('Upload');
    const detail = [
      vscode.l10n.t('The current version of each file (working tree) is sent.'),
      deleted ? vscode.l10n.t('{0} deleted or missing file(s) are not sent.', deleted) : '',
      skipped ? vscode.l10n.t('{0} file(s) are excluded by the deploy configuration.', skipped) : '',
      renamed.length ? vscode.l10n.t('Renamed files: the old copy stays on the server ({0}).', renamed.join(', ')) : '',
    ]
      .filter(Boolean)
      .join('\n');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('Upload {0} file(s) to {1}?', targets.length, hosts),
      { modal: true, detail },
      upload,
    );
    if (choice === upload) await api.upload(targets.map((target) => target.uri));
  }
}

function toNodes(entries: readonly TreeEntry[]): Node[] {
  return entries.map((entry) => (entry.kind === 'folder' ? { type: 'folder', folder: entry } : { type: 'file', change: entry.change }));
}

/** Nom affiché d'une référence : refs/heads/main → main, refs/tags/v1 → v1, refs/remotes/origin/x → origin/x. */
function shortRef(ref: string): string {
  return ref.replace(/^refs\/(heads|tags|remotes)\//, '');
}
