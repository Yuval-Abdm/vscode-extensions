// Vue « File History » (panneau Source Control) : commits d'un fichier ou d'une sélection de lignes, fichiers de
// chaque commit. Suit l'éditeur actif, sauf si elle est épinglée.
import path from 'node:path';
import * as vscode from 'vscode';
import type { GitCommands } from '../../git/commands.ts';
import { relativePath } from '../../git/locator.ts';
import type { FileChange, LogEntry } from '../../git/parsers/log.ts';
import type { Repos } from '../../git/repos.ts';
import { CancelledError } from '../../git/runner.ts';
import { absoluteDate, relativeTime } from '../../shared/dates.ts';
import { revisionUri } from '../../shared/revisions.ts';
import { changeDiffArgs, entryDiffArgs } from './model.ts';

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
    this.#view = vscode.window.createTreeView('gitForge.history', { treeDataProvider: this, showCollapseAll: true });
    const command = (id: string, run: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, run);
    this.#disposables = [
      this.#view,
      this.#changed,
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        clearTimeout(this.#followTimer);
        this.#followTimer = setTimeout(() => this.#follow(editor), FOLLOW_DELAY);
      }),
      repos.onDidChange(() => {
        // Nouveau commit, checkout… : l'historique affiché est périmé.
        const target = this.#target;
        if (target && this.#repos.locate(target.fileName)?.head !== this.#head) void this.#load(true);
      }),
      command('gitForge.showFileHistory', (uri?: vscode.Uri) => this.showFile(uri)),
      command('gitForge.showLineHistory', () => this.showLines()),
      command('gitForge.history.pin', () => this.#setPinned(true)),
      command('gitForge.history.unpin', () => {
        this.#setPinned(false);
        this.#follow(vscode.window.activeTextEditor);
      }),
      command('gitForge.history.refresh', () => this.#load(true)),
      command('gitForge.history.loadMore', () => this.#load(false)),
      command('gitForge.history.openRevision', (node: Node) => this.#openRevision(node)),
      command('gitForge.history.compareWithWorking', (node: Node) => this.#compareWithWorking(node)),
      command('gitForge.history.copySha', (node: Node) => {
        if (node.type !== 'more') return vscode.commands.executeCommand('gitForge.copySha', { sha: node.entry.sha });
      }),
      command('gitForge.history.copyMessage', (node: Node) => this.#copyMessage(node)),
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
    const editor = vscode.window.activeTextEditor;
    const fileName = uri?.scheme === 'file' ? uri.fsPath : editor?.document.uri.scheme === 'file' ? editor.document.fileName : undefined;
    if (fileName) this.#setTarget(this.#targetFor(fileName));
    await vscode.commands.executeCommand('gitForge.history.focus');
  }

  async showLines(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return;
    const { start, end } = editor.selection;
    // Sélection terminée en début de ligne : cette dernière ligne n'en fait pas partie.
    const last = end.line > start.line && end.character === 0 ? end.line - 1 : end.line;
    const base = this.#targetFor(editor.document.fileName);
    if (base) this.#setTarget({ ...base, kind: 'lines', start: start.line + 1, end: last + 1 });
    await vscode.commands.executeCommand('gitForge.history.focus');
  }

  getChildren(node?: Node): Node[] | Promise<Node[]> {
    if (!node) {
      const target = this.#target;
      if (!target) return [];
      const nodes: Node[] = this.#entries.map((entry) => ({ type: 'commit', root: target.root, trackedPath: target.relPath, entry }));
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
      item.command = { command: 'gitForge.history.loadMore', title: '' };
      return item;
    }
    if (node.type === 'file') {
      const { change } = node;
      const item = new vscode.TreeItem(path.posix.basename(change.path));
      const dir = path.posix.dirname(change.path);
      item.resourceUri = vscode.Uri.file(path.join(node.root, change.path));
      item.description = dir === '.' ? change.status : `${dir} · ${change.status}`;
      item.tooltip = change.oldPath ? `${change.oldPath} → ${change.path}` : change.path;
      item.contextValue = 'gitForge.commitFile';
      item.command = {
        command: 'gitForge.diffWithPrevious',
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
    item.contextValue = 'gitForge.commit';
    item.command = { command: 'gitForge.diffWithPrevious', title: '', arguments: [entryDiffArgs(node.root, entry, node.trackedPath)] };
    return item;
  }

  #targetFor(fileName: string): HistoryTarget | undefined {
    const location = this.#repos.locate(fileName);
    return location && { kind: 'file', root: location.root, relPath: relativePath(location.root, fileName), fileName };
  }

  #follow(editor: vscode.TextEditor | undefined): void {
    // Un éditeur de révision ou de diff (schéma git-forge:) ne change pas le fichier suivi.
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
    void vscode.commands.executeCommand('setContext', 'gitForge.history.pinned', pinned);
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
      entries = []; // fichier non suivi, lignes hors du fichier commité…
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
      files = this.#git.commitFiles(root, entry.sha, entry.parents[0]).catch(() => []);
      this.#files.set(key, files);
    }
    return files;
  }

  #openRevision(node: Node): unknown {
    if (node.type === 'more') return;
    const args = node.type === 'commit' ? entryDiffArgs(node.root, node.entry, node.trackedPath) : changeDiffArgs(node.root, node.entry.sha, node.entry.parents[0], node.change);
    // Fichier supprimé par ce commit : on ouvre sa dernière version, dans le parent.
    const ref = args.deleted && args.previousSha ? { root: args.root, sha: args.previousSha, path: args.previousPath ?? args.path } : args;
    return vscode.commands.executeCommand('gitForge.openRevision', ref);
  }

  #compareWithWorking(node: Node): unknown {
    if (node.type !== 'commit') return;
    const args = entryDiffArgs(node.root, node.entry, node.trackedPath);
    const left = revisionUri({ root: node.root, path: args.path, sha: args.deleted ? '' : args.sha });
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
