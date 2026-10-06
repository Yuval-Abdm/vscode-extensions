// Fonction « operations » : cherry-pick, revert, reset et rebase interactif depuis le graphe et l'historique ; éditeur
// personnalisé des fichiers git-rebase-todo (gitForge.rebaseEditor).
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { GitCommands } from '../../git/commands.ts';
import type { LogEntry } from '../../git/parsers/log.ts';
import type { Repos } from '../../git/repos.ts';
import { errorText } from '../merge/command.ts';
import { runRebaseEditor, openRebasePanel } from './rebasePanel.ts';
import { itemsFromCommits, RebaseChangedError, runInteractiveRebase } from './rebaseRun.ts';
import { parseTodo, serializeTodo, type RebaseItem } from './rebaseModel.ts';

/** Argument des commandes : contexte d'un menu du graphe ({ root, sha }) ou nœud de l'historique ({ root, entry }). */
type Target = { root?: string; sha?: string; entry?: LogEntry };

const TODO_ASSOCIATION = 'git-rebase-todo';
const TODO_EDITOR = 'gitForge.rebaseTodo';

export class OperationsFeature implements vscode.Disposable {
  readonly #git: GitCommands;
  readonly #extensionUri: vscode.Uri;
  readonly #disposables: vscode.Disposable[];

  constructor(git: GitCommands, _repos: Repos, extensionUri: vscode.Uri) {
    this.#git = git;
    this.#extensionUri = extensionUri;
    const command = (id: string, run: (target: Target) => unknown) =>
      vscode.commands.registerCommand(id, (target: Target) => {
        const root = target?.root;
        const sha = target?.sha ?? target?.entry?.sha;
        if (root && sha) return run({ root, sha });
      });
    this.#disposables = [
      command('gitForge.cherryPick', ({ root, sha }) => this.cherryPick(root as string, sha as string, true)),
      command('gitForge.revert', ({ root, sha }) => this.revert(root as string, sha as string, true)),
      command('gitForge.reset', ({ root, sha }) => this.reset(root as string, sha as string)),
      command('gitForge.interactiveRebase', ({ root, sha }) => this.interactiveRebase(root as string, sha as string)),
      vscode.window.registerCustomEditorProvider(TODO_EDITOR, new RebaseTodoEditor(extensionUri), {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitForge.rebaseEditor')) void this.#syncAssociation();
      }),
    ];
    void this.#syncAssociation();
  }

  dispose(): void {
    for (const disposable of this.#disposables) disposable.dispose();
  }

  async cherryPick(root: string, sha: string, confirm: boolean): Promise<void> {
    await this.#apply(root, sha, 'cherry-pick', confirm);
  }

  async revert(root: string, sha: string, confirm: boolean): Promise<void> {
    await this.#apply(root, sha, 'revert', confirm);
  }

  async #apply(root: string, sha: string, kind: 'cherry-pick' | 'revert', confirm: boolean): Promise<void> {
    if (await this.#busy(root)) return;
    const commit = await this.#git.commit(root, sha);
    if (!commit) return;
    const branch = (await this.#git.status(root)).branch.head ?? 'HEAD';
    const merge = commit.parents.length > 1;
    if (confirm) {
      const run = kind === 'cherry-pick' ? vscode.l10n.t('Cherry-pick') : vscode.l10n.t('Revert');
      const message =
        kind === 'cherry-pick'
          ? vscode.l10n.t('Cherry-pick {0} "{1}" onto {2}? A new commit applies the same changes.', sha.slice(0, 8), commit.summary, branch)
          : vscode.l10n.t('Revert {0} "{1}" on {2}? A new commit undoes its changes.', sha.slice(0, 8), commit.summary, branch);
      const detail = merge ? vscode.l10n.t('This is a merge commit: its changes relative to its first parent are used.') : undefined;
      if ((await vscode.window.showWarningMessage(message, { modal: true, detail }, run)) !== run) return;
    }
    let result;
    try {
      result = kind === 'cherry-pick' ? await this.#git.cherryPick(root, sha, merge ? 1 : undefined) : await this.#git.revert(root, sha, merge ? 1 : undefined);
    } catch (err) {
      void vscode.window.showErrorMessage(errorText(err));
      return;
    }
    if (result === 'done') {
      void vscode.window.showInformationMessage(kind === 'cherry-pick' ? vscode.l10n.t('Cherry-picked {0}.', sha.slice(0, 8)) : vscode.l10n.t('Reverted {0}.', sha.slice(0, 8)));
    } else if (result === 'conflicts') {
      void vscode.window.showWarningMessage(vscode.l10n.t('Conflicts: resolve them in the Conflicts view, then finish.'));
      void vscode.commands.executeCommand('gitForge.conflicts.focus');
    } else {
      void vscode.window.showWarningMessage(vscode.l10n.t('Nothing to apply: the changes of {0} are already there. Skip or abort it in the Conflicts view.', sha.slice(0, 8)));
      void vscode.commands.executeCommand('gitForge.conflicts.focus');
    }
  }

  async reset(root: string, sha: string, mode?: 'soft' | 'mixed' | 'hard', confirm = true): Promise<void> {
    if (await this.#busy(root)) return;
    const branch = (await this.#git.status(root)).branch.head ?? 'HEAD';
    if (!mode) {
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'soft', mode: 'soft' as const, detail: vscode.l10n.t('Move {0} to {1}; the undone commits’ changes stay staged.', branch, sha.slice(0, 8)) },
          { label: 'mixed', mode: 'mixed' as const, detail: vscode.l10n.t('Move {0} to {1}; the undone commits’ changes stay in your files, unstaged.', branch, sha.slice(0, 8)) },
          { label: 'hard', mode: 'hard' as const, detail: vscode.l10n.t('Move {0} to {1} and DISCARD every uncommitted change and the undone commits’ changes.', branch, sha.slice(0, 8)) },
        ],
        { title: vscode.l10n.t('Reset {0} to {1}', branch, sha.slice(0, 8)) },
      );
      if (!picked) return;
      mode = picked.mode;
    }
    const head = await this.#git.revParse(root, 'HEAD');
    // Commits qui ne seront plus accessibles depuis la branche : une sauvegarde est créée.
    const losesCommits = head !== undefined && !(await this.#git.isAncestor(root, head, sha));
    if (confirm && mode === 'hard') {
      const files = await this.#git.changedFiles(root);
      const reset = vscode.l10n.t('Reset (hard)');
      const detail = files.length
        ? vscode.l10n.t('These uncommitted changes are discarded: {0}', files.slice(0, 20).join(', ') + (files.length > 20 ? ' …' : ''))
        : vscode.l10n.t('No uncommitted change is discarded.');
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('Reset {0} to {1} and discard changes? A backup tag is created on the current commit first.', branch, sha.slice(0, 8)),
        { modal: true, detail },
        reset,
      );
      if (choice !== reset) return;
    }
    try {
      const tag = mode === 'hard' || losesCommits ? await this.#git.backupTag(root) : undefined;
      await this.#git.reset(root, sha, mode);
      void vscode.window.showInformationMessage(
        tag ? vscode.l10n.t('{0} reset to {1} ({2}). Backup: tag {3}.', branch, sha.slice(0, 8), mode, tag) : vscode.l10n.t('{0} reset to {1} ({2}).', branch, sha.slice(0, 8), mode),
      );
    } catch (err) {
      void vscode.window.showErrorMessage(errorText(err));
    }
  }

  async interactiveRebase(root: string, base: string): Promise<void> {
    if (await this.#busy(root)) return;
    const head = await this.#git.revParse(root, 'HEAD');
    if (!head || head === base || !(await this.#git.isAncestor(root, base, head))) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Pick a commit of the current branch, older than HEAD: the commits after it are rebased.'));
      return;
    }
    const commits = await this.#git.commitsForRebase(root, base);
    if (!commits.length) return;
    const merges = commits.some((commit) => commit.parents.length > 1);
    if (merges) {
      const go = vscode.l10n.t('Continue');
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('Merge commits in this range are not kept: their branches are flattened. Continue?'),
        { modal: true },
        go,
      );
      if (choice !== go) return;
    }
    // État à l'ouverture de l'éditeur : le lancement est refusé si HEAD ou la branche ont changé entre-temps.
    const guard = { head, branch: (await this.#git.status(root)).branch.head };
    const items = await openRebasePanel(this.#extensionUri, vscode.l10n.t('Interactive rebase onto {0}', base.slice(0, 8)), itemsFromCommits(commits.filter((c) => c.parents.length <= 1)));
    if (!items) return;
    try {
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Rebasing…') }, async () => {
        // Sauvegarde avant de réécrire l'historique (commits supprimés, fusionnés, merges aplatis).
        await this.#git.backupTag(root);
        return runInteractiveRebase(this.#git, root, base, items, guard);
      });
      if (result === 'done') void vscode.window.showInformationMessage(vscode.l10n.t('Rebase done.'));
      else if (result === 'autostash-conflicts') {
        void vscode.window.showWarningMessage(
          vscode.l10n.t('Rebase done, but your uncommitted changes conflict with the result: resolve them in the Conflicts view. They are also kept in the stash list.'),
        );
        void vscode.commands.executeCommand('gitForge.conflicts.focus');
      } else {
        const conflicts = (await this.#git.status(root)).conflicts.length;
        void vscode.window.showWarningMessage(
          conflicts
            ? vscode.l10n.t('The rebase stopped on conflicts: resolve them in the Conflicts view, then finish.')
            : vscode.l10n.t('The rebase stopped so you can amend the commit: change your files, commit (amend), then Finish in the Conflicts view.'),
        );
        void vscode.commands.executeCommand('gitForge.conflicts.focus');
      }
    } catch (err) {
      void vscode.window.showErrorMessage(
        err instanceof RebaseChangedError ? vscode.l10n.t('The branch changed since the rebase editor was opened: nothing was done, open it again.') : vscode.l10n.t('Rebase failed: {0}', errorText(err)),
      );
    }
  }

  async #busy(root: string): Promise<boolean> {
    const operation = await this.#git.operation(root);
    if (!operation) return false;
    void vscode.window.showErrorMessage(vscode.l10n.t('An operation is in progress ({0}): finish or abort it first (Conflicts view).', operation.kind));
    return true;
  }

  /** Associe (ou dissocie) les fichiers git-rebase-todo à l'éditeur de Git Forge selon gitForge.rebaseEditor. */
  async #syncAssociation(): Promise<void> {
    const wanted = vscode.workspace.getConfiguration('gitForge').get<boolean>('rebaseEditor', false);
    const workbench = vscode.workspace.getConfiguration('workbench');
    const associations = { ...workbench.inspect<Record<string, string>>('editorAssociations')?.globalValue };
    const current = associations[TODO_ASSOCIATION];
    const ours = current === TODO_EDITOR;
    if (wanted === ours) return;
    if (wanted && current !== undefined) {
      // Association déjà choisie par l'utilisateur (autre extension) : jamais écrasée.
      void vscode.window.showWarningMessage(vscode.l10n.t('git-rebase-todo files are already associated with the editor "{0}" (workbench.editorAssociations): remove that entry to use Git Forge\'s rebase editor.', current));
      return;
    }
    if (wanted) associations[TODO_ASSOCIATION] = TODO_EDITOR;
    else delete associations[TODO_ASSOCIATION];
    await workbench.update('editorAssociations', associations, vscode.ConfigurationTarget.Global);
  }
}

/** Éditeur personnalisé d'un git-rebase-todo (`git rebase -i` lancé ailleurs, avec VS Code comme éditeur de git). */
class RebaseTodoEditor implements vscode.CustomTextEditorProvider {
  readonly #extensionUri: vscode.Uri;

  constructor(extensionUri: vscode.Uri) {
    this.#extensionUri = extensionUri;
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const todo = parseTodo(document.getText());
    if (!todo) {
      // Commandes non prises en charge (exec, label, update-ref…) : éditeur de texte, ouvert avant de fermer celui-ci
      // (sinon `code --wait` rendrait la main à git avec la liste non modifiée).
      await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
      panel.dispose();
      return;
    }
    const items: RebaseItem[] = todo.map((item) => ({ ...item, message: item.summary, ident: '' }));
    const result = await runRebaseEditor(panel, this.#extensionUri, vscode.l10n.t('Interactive rebase'), items, false);
    // Onglet fermé sans décision : fichier inchangé (git continue avec la liste telle quelle).
    if (result === undefined) return;
    let text: string;
    if (result === 'abort') {
      // Liste vide : git abandonne un rebase qui commence (« Nothing to do »). Pendant un rebase déjà commencé
      // (--edit-todo, arrêt en cours), elle supprimerait les commits restants : on n'y touche pas.
      if (existsSync(path.join(path.dirname(document.uri.fsPath), 'done'))) {
        void vscode.window.showWarningMessage(vscode.l10n.t('This rebase has already started: abort it from the Conflicts view (Abort). The list was not changed.'));
        panel.dispose();
        return;
      }
      text = '';
    } else {
      text = serializeTodo(result.map((item) => ({ action: item.action, sha: item.sha, summary: item.summary })));
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, document.validateRange(new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, 0)), text);
    await vscode.workspace.applyEdit(edit);
    await document.save();
    panel.dispose(); // fermer l'onglet rend la main à `git rebase -i`
  }
}
