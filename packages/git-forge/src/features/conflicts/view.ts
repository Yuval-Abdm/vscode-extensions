// Vue « Conflicts » (panneau Source Control), visible pendant un merge, un rebase, un cherry-pick ou un revert, ou
// quand des fichiers sont en conflit : fichiers et blocs en conflit, choix du code à garder, fin ou abandon.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import type { GitCommands, Operation, OperationKind } from '../../git/commands.ts';
import type { ConflictFile, ConflictKind } from '../../git/parsers/status.ts';
import type { Repos } from '../../git/repos.ts';
import { GitError } from '../../git/runner.ts';
import { errorText, pendingDeletes, reportMerged, setPendingDelete } from '../merge/command.ts';
import { firstLine, settlePendingDelete } from '../merge/flow.ts';
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
  /** Après la première lecture seulement, l'apparition de conflits ouvre la vue (pas au démarrage). */
  #initialized = false;

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
      command('gitForge.conflicts.keepFile', (node: ConflictNode) => this.#run(() => this.#git.add(node.root, node.conflict.path))),
      command('gitForge.conflicts.deleteFile', (node: ConflictNode) => this.#deleteFile(node)),
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
    const item = new vscode.TreeItem(
      path.posix.basename(conflict.path),
      node.blocks.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    const dir = path.posix.dirname(conflict.path);
    item.description = dir === '.' ? kindLabel(conflict.kind) : `${dir} · ${kindLabel(conflict.kind)}`;
    item.resourceUri = uri;
    // text : les deux versions existent (blocs, mien / leur) ; gone : supprimé des deux côtés ; deleted : une seule
    // version existe (ajouté ou supprimé d'un côté) → garder ou supprimer le fichier.
    item.contextValue = TEXT_KINDS.includes(conflict.kind)
      ? 'gitForge.conflictFile.text'
      : conflict.kind === 'both-deleted'
        ? 'gitForge.conflictFile.gone'
        : 'gitForge.conflictFile.deleted';
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
    const state = await this.#pickState();
    if (!state) return;
    const { root, operation } = state;
    await saveDocumentsIn(root);
    const left = (await this.#git.status(root)).conflicts.length;
    if (left) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Resolve every file first ({0} left).', left));
      return;
    }
    if (!operation) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Conflicts resolved. If they came from a stash, the stash was kept.'));
      await this.refresh();
      return;
    }
    try {
      await this.#git.continueOperation(root, operation.kind);
      if (operation.kind === 'merge') void vscode.window.showInformationMessage(vscode.l10n.t('Merge committed.'));
    } catch (err) {
      await this.#afterFailedContinue(root, operation.kind, err);
    }
    await this.refresh();
  }

  async abort(): Promise<void> {
    const state = await this.#pickState();
    const operation = state?.operation;
    if (!state || !operation) return;
    const abort = vscode.l10n.t('Abort');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('Abort the {0}? The changes made while resolving conflicts are lost.', operationName(operation.kind)),
      { modal: true },
      abort,
    );
    if (choice !== abort) return;
    await this.#run(() => this.#git.abortOperation(state.root, operation.kind));
  }

  /** Rebase / cherry-pick / revert : un échec de --continue est souvent l'arrêt suivant, ou un commit devenu vide. */
  async #afterFailedContinue(root: string, kind: OperationKind, err: unknown): Promise<void> {
    const still = await this.#git.operation(root);
    if (still?.kind === kind && (await this.#git.status(root)).conflicts.length) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Next commit of the {0}: new conflicts to resolve.', operationName(kind)));
      return;
    }
    const stderr = err instanceof GitError ? `${err.stdout ?? ''}\n${err.stderr}` : '';
    if (still?.kind === kind && kind !== 'merge' && /nothing to commit|No changes|is now empty|empty/i.test(stderr)) {
      const skip = vscode.l10n.t('Skip This Commit');
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('The resolved commit is empty (its changes are already there). Skip it?'),
        skip,
      );
      if (choice === skip) await this.#run(() => this.#git.skipOperation(root, kind));
      return;
    }
    void vscode.window.showErrorMessage(vscode.l10n.t('Could not finish the {0}: {1}', operationName(kind), errorText(err)));
  }

  /** Dépôt sur lequel agir : le seul en cours, sinon un choix. */
  async #pickState(): Promise<RepoState | undefined> {
    await this.refresh();
    const states = this.#repoStates;
    if (states.length <= 1) return states[0];
    const picked = await vscode.window.showQuickPick(
      states.map((state) => ({ label: path.basename(state.root), description: state.operation ? operationTitle(state.operation) : undefined, state })),
      { placeHolder: vscode.l10n.t('Repository') },
    );
    return picked?.state;
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
    const previous = new Map(this.#repoStates.map((state) => [state.root, state]));
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
        // dépôt en cours de modification (index.lock…) : on garde son état précédent, relu au prochain changement
        const kept = previous.get(root);
        if (kept) states.push(kept);
      }
    }
    this.#repoStates = states;
    await this.#settlePendingDeletes();
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
    if (this.#initialized && !before && count) void vscode.commands.executeCommand('gitForge.conflicts.focus');
    this.#initialized = true;
  }

  /** Suppressions de branche en attente : faites quand le merge est commité (ici ou ailleurs), oubliées sinon. */
  async #settlePendingDeletes(): Promise<void> {
    for (const pending of pendingDeletes(this.#state)) {
      if (!this.#repos.roots().includes(pending.root)) continue;
      let result;
      try {
        result = await settlePendingDelete(this.#git, pending);
      } catch {
        continue;
      }
      if (result === 'wait') continue;
      await setPendingDelete(this.#state, pending.root, undefined);
      if (result !== 'drop') void reportMerged(this.#git, pending.root, pending.source, pending.target, { upToDate: false, ...result });
    }
  }

  async #keepBlock(node: ConflictNode, choice: Choice): Promise<void> {
    if (node.type !== 'block') return;
    const doc = await vscode.workspace.openTextDocument(fileUri(node));
    // Sans modification non enregistrée, le disque fait foi : le document n'est peut-être pas encore rechargé.
    const text = doc.isDirty ? doc.getText() : await readFile(doc.uri.fsPath, 'utf8').catch(() => doc.getText());
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    // Le fichier a pu changer depuis l'affichage : on ne touche qu'au bloc qui est toujours au même endroit.
    const block = findConflicts(lines).find((b) => b.start === node.block.start && b.end === node.block.end);
    if (!block) {
      void vscode.window.showInformationMessage(vscode.l10n.t('The file changed: the conflict list was refreshed, try again.'));
      return void this.refresh();
    }
    const result = [...lines.slice(0, block.start), ...resolveBlock(lines, block, choice), ...lines.slice(block.end + 1)].join(eol);
    if (doc.isDirty) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, doc.validateRange(new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)), result);
      await vscode.workspace.applyEdit(edit);
    } else {
      // Écrit sur le disque : VS Code recharge le document, sans conflit d'enregistrement avec la version de git.
      await writeFile(doc.uri.fsPath, result);
    }
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(block.start, 0, block.start, 0), preview: false });
    await this.refresh();
  }

  /** Version entière « mienne » ou « leur », puis fichier marqué résolu. */
  async #keepFile(node: ConflictNode, side: 'ours' | 'theirs'): Promise<void> {
    const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === fileUri(node).toString());
    if (open?.isDirty) await open.save();
    await this.#run(async () => {
      await this.#git.checkoutSide(node.root, node.conflict.path, side);
      await this.#git.add(node.root, node.conflict.path);
    });
  }

  async #deleteFile(node: ConflictNode): Promise<void> {
    // Document ouvert et modifié : enregistré d'abord, sinon un enregistrement ultérieur recréerait le fichier.
    const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === fileUri(node).toString());
    if (open?.isDirty) await open.save();
    await this.#run(() => this.#git.remove(node.root, node.conflict.path));
  }

  async #markResolved(node: ConflictNode): Promise<void> {
    if (TEXT_KINDS.includes(node.conflict.kind)) {
      let doc: vscode.TextDocument | undefined;
      try {
        doc = await vscode.workspace.openTextDocument(fileUri(node));
      } catch {
        doc = undefined; // fichier binaire : pas de marqueurs à vérifier
      }
      if (doc?.isDirty) await doc.save();
      // Texte du disque : le document ouvert n'est peut-être pas encore rechargé après l'écriture de git.
      const text = doc ? await readFile(doc.uri.fsPath, 'utf8').catch(() => doc.getText()) : '';
      if (hasConflictMarkers(text)) {
        void vscode.window.showWarningMessage(vscode.l10n.t('{0} still has conflict markers.', path.posix.basename(node.conflict.path)));
        return;
      }
    }
    await this.#run(() => this.#git.add(node.root, node.conflict.path));
  }

  async #run(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      void vscode.window.showErrorMessage(err instanceof GitError ? firstLine(err.stderr) || err.message : errorText(err));
    }
    await this.refresh();
  }
}

function fileUri(node: ConflictNode): vscode.Uri {
  return vscode.Uri.file(path.join(node.root, node.conflict.path));
}

/**
 * Blocs d'un fichier en conflit textuel : dans l'éditeur s'il a des modifications non enregistrées, sinon sur le
 * disque (un document ouvert n'est pas encore rechargé juste après que git a écrit le fichier).
 */
async function blocksOf(root: string, conflict: ConflictFile): Promise<ConflictBlock[]> {
  if (!TEXT_KINDS.includes(conflict.kind)) return [];
  const uri = vscode.Uri.file(path.join(root, conflict.path));
  const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
  try {
    const text = open?.isDirty ? open.getText() : await readFile(uri.fsPath, 'utf8');
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
