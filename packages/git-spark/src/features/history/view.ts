// Vue « File History » (panneau Source Control) : commits d'un fichier ou d'une sélection de lignes, fichiers de
// chaque commit. Suit l'éditeur actif, sauf si elle est épinglée.
import path from 'node:path';
import * as vscode from 'vscode';
import type { GitCommands } from '../../git/commands.ts';
import { relativePath } from '../../git/locator.ts';
import type { FileChange, LogEntry } from '../../git/parsers/log.ts';
import type { Repos } from '../../git/repos.ts';
import { CancelledError, GitError } from '../../git/runner.ts';
import { absoluteDate, relativeTime } from '../../shared/dates.ts';
import { revisionUri } from '../../shared/revisions.ts';
import { changeDiffArgs, entryDiffArgs, mapToHead } from './model.ts';

const PAGE = 50;
const FOLLOW_DELAY = 250;

export type HistoryTarget =
  | { kind: 'file'; root: string; relPath: string; fileName: string }
  | { kind: 'lines'; root: string; relPath: string; fileName: string; start: number; end: number };

type Node =
  | { type: 'commit'; root: string; trackedPath: string; entry: LogEntry }
  | { type: 'file'; root: string; entry: LogEntry; change: FileChange }
  | { type: 'more' };

export class HistoryView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  readonly #git: GitCommands;
  readonly #repos: Repos;
  readonly #changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.#changed.event;
  readonly #view: vscode.TreeView<Node>;
  readonly #disposables: vscode.Disposable[];
  readonly #files = new Map<string, Promise<FileChange[]>>();
  #target: HistoryTarget | undefined;
  #head: string | undefined;
  #entries: LogEntry[] = [];
  #hasMore = false;
  #pinned = false;
  #loading: AbortController | undefined;
  #followTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(git: GitCommands, repos: Repos) {
    this.#git = git;
    this.#repos = repos;
    this.#view = vscode.window.createTreeView('gitSpark.history', { treeDataProvider: this, showCollapseAll: true });
    const command = (id: string, run: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, run);
    this.#disposables = [
      this.#view,
      this.#changed,
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        clearTimeout(this.#followTimer);
        this.#followTimer = setTimeout(() => this.#follow(editor), FOLLOW_DELAY);
      }),
      repos.onDidChange(() => {
        // Dépôt ouvert après la vue : le fichier actif peut maintenant être suivi.
        const target = this.#target;
        if (!target) return this.#follow(vscode.window.activeTextEditor);
        // Nouveau commit, checkout… : l'historique affiché est périmé.
        if (this.#repos.locate(target.fileName)?.head !== this.#head) {
          this.#files.clear();
          void this.#load(true);
        }
      }),
      command('gitSpark.showFileHistory', (uri?: vscode.Uri) => this.showFile(uri)),
      command('gitSpark.showLineHistory', () => this.showLines()),
      command('gitSpark.history.pin', () => this.#setPinned(true)),
      command('gitSpark.history.unpin', () => {
        this.#setPinned(false);
        this.#follow(vscode.window.activeTextEditor);
      }),
      command('gitSpark.history.refresh', () => {
        this.#files.clear();
        return this.#load(true);
      }),
      command('gitSpark.history.loadMore', () => this.#load(false)),
      command('gitSpark.history.openRevision', (node: Node) => this.#openRevision(node)),
      command('gitSpark.history.compareWithWorking', (node: Node) => this.#compareWithWorking(node)),
      command('gitSpark.history.copySha', (node: Node) => {
        if (node.type !== 'more') return vscode.commands.executeCommand('gitSpark.copySha', { sha: node.entry.sha });
      }),
      command('gitSpark.history.copyMessage', (node: Node) => this.#copyMessage(node)),
    ];
    this.#setPinned(false);
    this.#follow(vscode.window.activeTextEditor);
    if (!this.#target) void this.#load(true);
  }

  /** Fichier ou lignes affichés (tests e2e). */
  get target(): HistoryTarget | undefined {
    return this.#target;
  }

  /** Commits chargés (tests e2e). */
  get entries(): readonly LogEntry[] {
    return this.#entries;
  }

  dispose(): void {
    clearTimeout(this.#followTimer);
    this.#loading?.abort();
    for (const disposable of this.#disposables) disposable.dispose();
  }

  async showFile(uri?: vscode.Uri): Promise<void> {
    clearTimeout(this.#followTimer);
    const editor = vscode.window.activeTextEditor;
    const active = editor?.document.uri.scheme === 'file' ? editor.document.fileName : undefined;
    const fileName = uri?.scheme === 'file' ? uri.fsPath : active;
    if (fileName) {
      // Fichier choisi dans l'Explorateur, autre que l'éditeur actif : la vue est épinglée pour le garder.
      if (fileName !== active) this.#setPinned(true);
      this.#setTarget(this.#targetFor(fileName));
    }
    await vscode.commands.executeCommand('gitSpark.history.focus');
  }

  async showLines(): Promise<void> {
    clearTimeout(this.#followTimer);
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return;
    const { start, end } = editor.selection;
    // Sélection terminée en début de ligne : cette dernière ligne n'en fait pas partie.
    const last = end.line > start.line && end.character === 0 ? end.line - 1 : end.line;
    const base = this.#targetFor(editor.document.fileName);
    if (!base) return;
    // git log -L compte les lignes de HEAD : la sélection de l'éditeur y est ramenée (lignes non commitées retirées).
    let hunks;
    try {
      hunks = await this.#git.diffHead(base.root, base.relPath, editor.document.getText());
    } catch {
      void vscode.window.showInformationMessage(vscode.l10n.t('This file has no commit yet.'));
      return;
    }
    const lines = mapToHead(hunks, start.line + 1, last + 1);
    if (!lines) {
      void vscode.window.showInformationMessage(vscode.l10n.t('The selected lines are not committed yet: they have no history.'));
      return;
    }
    this.#setTarget({ ...base, kind: 'lines', start: lines.start, end: lines.end });
    await vscode.commands.executeCommand('gitSpark.history.focus');
  }

  getChildren(node?: Node): Node[] | Promise<Node[]> {
    if (!node) {
      const target = this.#target;
      if (!target) return [];
      // Chemin du fichier à chaque commit : un merge n'en liste pas, il garde celui du commit plus ancien suivant.
      let trackedPath = target.relPath;
      const paths = [...this.#entries].reverse().map((entry) => (trackedPath = entry.files[0]?.path ?? trackedPath)).reverse();
      const nodes: Node[] = this.#entries.map((entry, i) => ({ type: 'commit', root: target.root, trackedPath: paths[i], entry }));
      if (this.#hasMore) nodes.push({ type: 'more' });
      return nodes;
    }
    if (node.type !== 'commit') return [];
    return this.#commitFiles(node.root, node.entry).then((changes) =>
      changes.map((change): Node => ({ type: 'file', root: node.root, entry: node.entry, change })),
    );
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === 'more') {
      const item = new vscode.TreeItem(vscode.l10n.t('Load more…'));
      item.iconPath = new vscode.ThemeIcon('ellipsis');
      item.command = { command: 'gitSpark.history.loadMore', title: '' };
      return item;
    }
    if (node.type === 'file') {
      const { change } = node;
      const item = new vscode.TreeItem(path.posix.basename(change.path));
      const dir = path.posix.dirname(change.path);
      item.resourceUri = vscode.Uri.file(path.join(node.root, change.path));
      item.description = dir === '.' ? change.status : `${dir} · ${change.status}`;
      item.tooltip = change.oldPath ? `${change.oldPath} → ${change.path}` : change.path;
      item.contextValue = 'gitSpark.commitFile';
      item.command = {
        command: 'gitSpark.diffWithPrevious',
        title: '',
        arguments: [changeDiffArgs(node.root, node.entry.sha, node.entry.parents[0], change)],
      };
      return item;
    }
    const { entry } = node;
    const item = new vscode.TreeItem(entry.summary || entry.sha.slice(0, 8), vscode.TreeItemCollapsibleState.Collapsed);
    item.description = `${entry.author}, ${relativeTime(entry.authorTime, Date.now(), vscode.env.language)}`;
    item.iconPath = new vscode.ThemeIcon(entry.parents.length > 1 ? 'git-merge' : 'git-commit');
    item.tooltip = tooltip(entry);
    item.contextValue = 'gitSpark.commit';
    item.command = { command: 'gitSpark.diffWithPrevious', title: '', arguments: [entryDiffArgs(node.root, entry, node.trackedPath)] };
    return item;
  }

  #targetFor(fileName: string): HistoryTarget | undefined {
    const location = this.#repos.locate(fileName);
    return location && { kind: 'file', root: location.root, relPath: relativePath(location.root, fileName), fileName };
  }

  #follow(editor: vscode.TextEditor | undefined): void {
    // Un éditeur de révision ou de diff (schéma git-spark:) ne change pas le fichier suivi.
    if (this.#pinned || !editor || editor.document.uri.scheme !== 'file') return;
    if (this.#target?.fileName === editor.document.fileName) return;
    this.#setTarget(this.#targetFor(editor.document.fileName));
  }

  #setTarget(target: HistoryTarget | undefined): void {
    this.#target = target;
    this.#files.clear();
    void this.#load(true);
  }

  #setPinned(pinned: boolean): void {
    this.#pinned = pinned;
    void vscode.commands.executeCommand('setContext', 'gitSpark.history.pinned', pinned);
    this.#describe();
  }

  #describe(): void {
    const target = this.#target;
    if (!target) {
      this.#view.description = undefined;
      return;
    }
    const name = path.basename(target.fileName);
    const label = target.kind === 'lines' ? vscode.l10n.t('{0}, lines {1}–{2}', name, target.start, target.end) : name;
    this.#view.description = this.#pinned ? vscode.l10n.t('{0} (pinned)', label) : label;
  }

  async #load(reset: boolean): Promise<void> {
    this.#loading?.abort();
    const loading = new AbortController();
    this.#loading = loading;
    if (reset) {
      this.#entries = [];
      this.#hasMore = false;
    }
    this.#describe();
    const target = this.#target;
    if (!target) {
      this.#view.message = vscode.l10n.t('Open a file tracked by Git to see its history.');
      this.#changed.fire(undefined);
      return;
    }
    this.#head = this.#repos.locate(target.fileName)?.head;
    const page = { skip: this.#entries.length, limit: PAGE, signal: loading.signal };
    let entries: LogEntry[];
    try {
      entries =
        target.kind === 'file'
          ? await this.#git.fileHistory(target.root, target.relPath, page)
          : await this.#git.lineHistory(target.root, target.relPath, target.start, target.end, page);
    } catch (err) {
      if (err instanceof CancelledError) return;
      if (this.#loading !== loading) return;
      this.#view.message =
        err instanceof GitError && /has only \d+ lines?/.test(err.stderr)
          ? vscode.l10n.t('The selected lines are beyond the last committed version of the file.')
          : vscode.l10n.t('Git error: {0}', err instanceof GitError ? err.stderr.trim().split('\n')[0] : String(err));
      this.#changed.fire(undefined);
      return;
    }
    if (this.#loading !== loading) return;
    this.#entries = [...this.#entries, ...entries];
    this.#hasMore = entries.length === PAGE;
    this.#view.message = this.#entries.length ? undefined : vscode.l10n.t('No commits for this file.');
    this.#changed.fire(undefined);
  }

  #commitFiles(root: string, entry: LogEntry): Promise<FileChange[]> {
    const key = `${root}\0${entry.sha}`;
    let files = this.#files.get(key);
    if (!files) {
      files = this.#git.commitFiles(root, entry.sha, entry.parents[0]).catch(() => {
        this.#files.delete(key);
        return [];
      });
      this.#files.set(key, files);
    }
    return files;
  }

  #openRevision(node: Node): unknown {
    if (node.type === 'more') return;
    const args = node.type === 'commit' ? entryDiffArgs(node.root, node.entry, node.trackedPath) : changeDiffArgs(node.root, node.entry.sha, node.entry.parents[0], node.change);
    // Fichier supprimé par ce commit : on ouvre sa dernière version, dans le parent.
    const ref = args.deleted && args.previousSha ? { root: args.root, sha: args.previousSha, path: args.previousPath ?? args.path } : args;
    return vscode.commands.executeCommand('gitSpark.openRevision', ref);
  }

  #compareWithWorking(node: Node): unknown {
    if (node.type !== 'commit') return;
    const args = entryDiffArgs(node.root, node.entry, node.trackedPath);
    // Commit qui supprime le fichier : on compare sa dernière version, dans le parent.
    const left =
      args.deleted && args.previousSha
        ? revisionUri({ root: node.root, path: args.previousPath ?? args.path, sha: args.previousSha })
        : revisionUri({ root: node.root, path: args.path, sha: args.sha });
    const right = vscode.Uri.file(path.join(node.root, node.trackedPath));
    const title = vscode.l10n.t('{0} ({1} ↔ working tree)', path.posix.basename(node.trackedPath), node.entry.sha.slice(0, 7));
    return vscode.commands.executeCommand('vscode.diff', left, right, title);
  }

  async #copyMessage(node: Node): Promise<void> {
    if (node.type === 'more') return;
    const message = await this.#git.message(node.root, node.entry.sha).catch(() => node.entry.summary);
    await vscode.env.clipboard.writeText(message);
    vscode.window.setStatusBarMessage(vscode.l10n.t('Commit message copied.'), 3000);
  }
}

function tooltip(entry: LogEntry): vscode.MarkdownString {
  const md = new vscode.MarkdownString('', true);
  md.appendMarkdown(`$(git-commit) \`${entry.sha.slice(0, 8)}\` · `);
  md.appendText(`${entry.author} <${entry.authorMail}>`);
  md.appendMarkdown(` · ${absoluteDate(entry.authorTime, vscode.env.language)}\n\n`);
  md.appendText(entry.summary);
  return md;
}
