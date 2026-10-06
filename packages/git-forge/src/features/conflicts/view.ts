// Vue « Conflicts » (panneau Source Control), visible pendant un merge, un rebase, un cherry-pick ou un revert, ou
// quand des fichiers sont en conflit : fichiers et blocs en conflit, choix du code à garder, fin ou abandon.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import type { GitCommands, Operation, OperationKind } from '../../git/commands.ts';
import type { ConflictFile, ConflictKind } from '../../git/parsers/status.ts';
import type { Repos } from '../../git/repos.ts';
import { deleteSourceBranch } from '../merge/flow.ts';
import { errorText, PENDING_DELETE, reportMerged, type PendingDelete } from '../merge/command.ts';
import { findConflicts, hasConflictMarkers, resolveBlock, type Choice, type ConflictBlock } from './markers.ts';

const REFRESH_DELAY = 200;
const TEXT_KINDS: ConflictKind[] = ['both-modified', 'both-added'];

export type ConflictNode =
  | { type: 'file'; root: string; conflict: ConflictFile; blocks: ConflictBlock[] }
  | { type: 'block'; root: string; conflict: ConflictFile; block: ConflictBlock; index: number };

interface RepoState {
  root: string;
  operation: Operation | undefined;
  files: Extract<ConflictNode, { type: 'file' }>[];
}

export class ConflictsView implements vscode.TreeDataProvider<ConflictNode>, vscode.Disposable {
  readonly #git: GitCommands;
  readonly #repos: Repos;
  readonly #state: vscode.Memento;
  readonly #changed = new vscode.EventEmitter<ConflictNode | undefined>();
  readonly onDidChangeTreeData = this.#changed.event;
  readonly #view: vscode.TreeView<ConflictNode>;
  readonly #disposables: vscode.Disposable[];
  #repoStates: RepoState[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #refreshing: Promise<void> | undefined;
  #again = false;

  constructor(git: GitCommands, repos: Repos, state: vscode.Memento) {
    this.#git = git;
    this.#repos = repos;
    this.#state = state;
    this.#view = vscode.window.createTreeView('gitForge.conflicts', { treeDataProvider: this });
    const command = (id: string, run: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, run);
    this.#disposables = [
      this.#view,
      this.#changed,
      repos.onDidChange(() => this.#schedule()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length && this.#isConflictFile(e.document.uri)) this.#schedule();
      }),
      command('gitForge.conflicts.refresh', () => this.refresh()),
      command('gitForge.conflicts.keepOurs', (node: ConflictNode) => this.#keepBlock(node, 'ours')),
      command('gitForge.conflicts.keepTheirs', (node: ConflictNode) => this.#keepBlock(node, 'theirs')),
      command('gitForge.conflicts.keepBoth', (node: ConflictNode) => this.#keepBlock(node, 'both')),
      command('gitForge.conflicts.keepAllOurs', (node: ConflictNode) => this.#keepFile(node, 'ours')),
      command('gitForge.conflicts.keepAllTheirs', (node: ConflictNode) => this.#keepFile(node, 'theirs')),
      command('gitForge.conflicts.openMergeEditor', (node: ConflictNode) =>
        vscode.commands.executeCommand('git.openMergeEditor', fileUri(node)),
      ),
      command('gitForge.conflicts.markResolved', (node: ConflictNode) => this.#markResolved(node)),
      command('gitForge.conflicts.keepFile', (node: ConflictNode) => this.#run(node.root, () => this.#git.add(node.root, node.conflict.path))),
      command('gitForge.conflicts.deleteFile', (node: ConflictNode) => this.#run(node.root, () => this.#git.remove(node.root, node.conflict.path))),
      command('gitForge.conflicts.finish', () => this.finish()),
      command('gitForge.conflicts.abort', () => this.abort()),
    ];
    void this.refresh();
  }

  /** Fichiers en conflit de tous les dépôts (tests e2e). */
  get files(): readonly ConflictNode[] {
    return this.#repoStates.flatMap((state) => state.files);
  }

  dispose(): void {
    clearTimeout(this.#timer);
    for (const disposable of this.#disposables) disposable.dispose();
    void vscode.commands.executeCommand('setContext', 'gitForge.conflicts.active', false);
  }

  getChildren(node?: ConflictNode): ConflictNode[] {
    if (!node) return [...this.files];
    if (node.type !== 'file') return [];
    return node.blocks.map((block, index) => ({ type: 'block', root: node.root, conflict: node.conflict, block, index }));
  }

  getTreeItem(node: ConflictNode): vscode.TreeItem {
    const uri = fileUri(node);
    if (node.type === 'block') {
      const item = new vscode.TreeItem(vscode.l10n.t('Conflict {0}', node.index + 1));
      item.description = vscode.l10n.t('lines {0}–{1}', node.block.start + 1, node.block.end + 1);
      item.tooltip = `${node.block.oursLabel || 'ours'} ↔ ${node.block.theirsLabel || 'theirs'}`;
      item.iconPath = new vscode.ThemeIcon('git-merge');
      item.contextValue = 'gitForge.conflictBlock';
      item.command = {
        command: 'vscode.open',
        title: '',
        arguments: [uri, { selection: new vscode.Range(node.block.start, 0, node.block.start, 0) }],
      };
      return item;
    }
    const { conflict } = node;
    const textual = TEXT_KINDS.includes(conflict.kind);
    const item = new vscode.TreeItem(
      path.posix.basename(conflict.path),
      node.blocks.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    const dir = path.posix.dirname(conflict.path);
    item.description = dir === '.' ? kindLabel(conflict.kind) : `${dir} · ${kindLabel(conflict.kind)}`;
    item.resourceUri = uri;
    item.contextValue = textual ? 'gitForge.conflictFile.text' : conflict.kind.startsWith('deleted-by') ? 'gitForge.conflictFile.deleted' : 'gitForge.conflictFile.other';
    if (conflict.kind !== 'both-deleted') item.command = { command: 'vscode.open', title: '', arguments: [uri] };
    return item;
  }

  /** Relit l'état de tous les dépôts (regroupe les appels concurrents). */
  async refresh(): Promise<void> {
    if (this.#refreshing) {
      this.#again = true;
      return this.#refreshing;
    }
    this.#refreshing = (async () => {
      do {
        this.#again = false;
        await this.#read();
      } while (this.#again);
    })().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async finish(): Promise<void> {
    for (const state of this.#repoStates) {
      const { root, operation } = state;
      await saveDocumentsIn(root);
      const left = (await this.#git.status(root)).conflicts.length;
      if (left) {
        void vscode.window.showWarningMessage(vscode.l10n.t('Resolve every file first ({0} left).', left));
        continue;
      }
      if (!operation) {
        void vscode.window.showInformationMessage(vscode.l10n.t('Conflicts resolved. If they came from a stash, the stash was kept.'));
        continue;
      }
      try {
        await this.#git.continueOperation(root, operation.kind);
      } catch (err) {
        void vscode.window.showErrorMessage(vscode.l10n.t('Could not finish the {0}: {1}', operationName(operation.kind), errorText(err)));
        continue;
      }
      const pending = this.#state.get<PendingDelete>(PENDING_DELETE);
      if (operation.kind === 'merge' && pending?.root === root) {
        await this.#state.update(PENDING_DELETE, undefined);
        const deleted = await deleteSourceBranch(this.#git, root, pending.source, pending.mode);
        void reportMerged(this.#git, root, pending.source, pending.target, { upToDate: false, ...deleted });
      } else if (operation.kind === 'merge') {
        void vscode.window.showInformationMessage(vscode.l10n.t('Merge committed.'));
      }
    }
    await this.refresh();
  }

  async abort(): Promise<void> {
    for (const { root, operation } of this.#repoStates) {
      if (!operation) continue;
      const abort = vscode.l10n.t('Abort');
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('Abort the {0}? The changes made while resolving conflicts are lost.', operationName(operation.kind)),
        { modal: true },
        abort,
      );
      if (choice !== abort) continue;
      if (this.#state.get<PendingDelete>(PENDING_DELETE)?.root === root) await this.#state.update(PENDING_DELETE, undefined);
      await this.#run(root, () => this.#git.abortOperation(root, operation.kind));
    }
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.refresh(), REFRESH_DELAY);
  }

  #isConflictFile(uri: vscode.Uri): boolean {
    return this.files.some((node) => fileUri(node).toString() === uri.toString());
  }

  async #read(): Promise<void> {
    const before = this.files.length;
    const states: RepoState[] = [];
    for (const root of this.#repos.roots()) {
      try {
        const [status, operation] = await Promise.all([this.#git.status(root), this.#git.operation(root)]);
        if (!status.conflicts.length && !operation) continue;
        const files = await Promise.all(
          status.conflicts.map(async (conflict) => ({ type: 'file' as const, root, conflict, blocks: await blocksOf(root, conflict) })),
        );
        states.push({ root, operation, files });
      } catch {
        // dépôt en cours de modification : relu au prochain changement
      }
    }
    this.#repoStates = states;
    const count = this.files.length;
    void vscode.commands.executeCommand('setContext', 'gitForge.conflicts.active', states.length > 0);
    const main = states.find((state) => state.operation) ?? states[0];
    this.#view.description = main?.operation
      ? `${operationTitle(main.operation)} · ${vscode.l10n.t('{0} file(s) left', count)}`
      : count
        ? vscode.l10n.t('{0} file(s) left', count)
        : undefined;
    this.#view.message =
      main?.operation && !count ? vscode.l10n.t('All conflicts are resolved: finish the {0} with ✓ in the title bar.', operationName(main.operation.kind)) : undefined;
    this.#changed.fire(undefined);
    if (!before && count) void vscode.commands.executeCommand('gitForge.conflicts.focus');
  }

  async #keepBlock(node: ConflictNode, choice: Choice): Promise<void> {
    if (node.type !== 'block') return;
    const doc = await vscode.workspace.openTextDocument(fileUri(node));
    const lines = doc.getText().split(/\r?\n/);
    const blocks = findConflicts(lines);
    // Le fichier a pu changer depuis l'affichage : même ligne de départ, sinon même rang.
    const block = blocks.find((b) => b.start === node.block.start) ?? blocks[node.index];
    if (!block) return void this.refresh();
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const replacement = resolveBlock(lines, block, choice);
    const edit = new vscode.WorkspaceEdit();
    if (block.end + 1 < doc.lineCount) {
      edit.replace(doc.uri, new vscode.Range(block.start, 0, block.end + 1, 0), replacement.map((line) => line + eol).join(''));
    } else {
      edit.replace(doc.uri, new vscode.Range(block.start, 0, block.end, doc.lineAt(block.end).text.length), replacement.join(eol));
    }
    await vscode.workspace.applyEdit(edit);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(block.start, 0, block.start, 0), preview: false });
    await this.refresh();
  }

  async #keepFile(node: ConflictNode, side: 'ours' | 'theirs'): Promise<void> {
    const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === fileUri(node).toString());
    if (open?.isDirty) await open.save();
    await this.#run(node.root, () => this.#git.checkoutSide(node.root, node.conflict.path, side));
  }

  async #markResolved(node: ConflictNode): Promise<void> {
    if (TEXT_KINDS.includes(node.conflict.kind)) {
      const doc = await vscode.workspace.openTextDocument(fileUri(node));
      if (doc.isDirty) await doc.save();
      if (hasConflictMarkers(doc.getText())) {
        void vscode.window.showWarningMessage(vscode.l10n.t('{0} still has conflict markers.', path.posix.basename(node.conflict.path)));
        return;
      }
    }
    await this.#run(node.root, () => this.#git.add(node.root, node.conflict.path));
  }

  async #run(root: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      void vscode.window.showErrorMessage(errorText(err));
    }
    void root;
    await this.refresh();
  }
}

function fileUri(node: ConflictNode): vscode.Uri {
  return vscode.Uri.file(path.join(node.root, node.conflict.path));
}

/** Blocs d'un fichier en conflit textuel, lus dans l'éditeur s'il est ouvert, sinon sur le disque. */
async function blocksOf(root: string, conflict: ConflictFile): Promise<ConflictBlock[]> {
  if (!TEXT_KINDS.includes(conflict.kind)) return [];
  const uri = vscode.Uri.file(path.join(root, conflict.path));
  const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
  try {
    const text = open ? open.getText() : await readFile(uri.fsPath, 'utf8');
    return findConflicts(text.split(/\r?\n/));
  } catch {
    return [];
  }
}

async function saveDocumentsIn(root: string): Promise<void> {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  await Promise.all(vscode.workspace.textDocuments.filter((doc) => doc.isDirty && doc.uri.scheme === 'file' && doc.fileName.startsWith(prefix)).map((doc) => doc.save()));
}

function kindLabel(kind: ConflictKind): string {
  switch (kind) {
    case 'both-modified':
      return vscode.l10n.t('both modified');
    case 'both-added':
      return vscode.l10n.t('both added');
    case 'both-deleted':
      return vscode.l10n.t('both deleted');
    case 'added-by-us':
      return vscode.l10n.t('added by us');
    case 'added-by-them':
      return vscode.l10n.t('added by them');
    case 'deleted-by-us':
      return vscode.l10n.t('deleted by us');
    case 'deleted-by-them':
      return vscode.l10n.t('deleted by them');
  }
}

function operationName(kind: OperationKind): string {
  switch (kind) {
    case 'merge':
      return vscode.l10n.t('merge');
    case 'rebase':
      return vscode.l10n.t('rebase');
    case 'cherry-pick':
      return vscode.l10n.t('cherry-pick');
    case 'revert':
      return vscode.l10n.t('revert');
  }
}

function operationTitle(operation: Operation): string {
  switch (operation.kind) {
    case 'merge':
      return operation.label ?? vscode.l10n.t('Merge');
    case 'rebase':
      return operation.label ? vscode.l10n.t('Rebase of {0}', operation.label) : vscode.l10n.t('Rebase');
    case 'cherry-pick':
      return vscode.l10n.t('Cherry-pick');
    case 'revert':
      return vscode.l10n.t('Revert');
  }
}
