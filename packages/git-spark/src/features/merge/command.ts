// Commande « Merge Locally » : choix de la branche source (et de la cible), options mémorisées, déroulé avec
// progression, puis bilan : conflits → vue Conflicts ; merge fait → proposition de pousser.
import * as vscode from 'vscode';
import type { GitCommands } from '../../git/commands.ts';
import type { Repos } from '../../git/repos.ts';
import { pickRepo } from '../../shared/pickRepo.ts';
import { errorText, showConflictsView, whereToFinish } from '../../shared/errors.ts';

export { errorText } from '../../shared/errors.ts';
import { firstLine, mergeLocal, type DeleteMode, type MergeOptions, type MergeOutcome, type MergeStep, type PendingDelete } from './flow.ts';

/** Suppressions de branche demandées pendant un merge resté en conflit, par dépôt (traitées par la vue Conflicts). */
const PENDING_DELETES = 'gitSpark.pendingMergeDeletes';
const OPTIONS = 'gitSpark.mergeOptions';

export function pendingDeletes(state: vscode.Memento): PendingDelete[] {
  return Object.values(state.get<Record<string, PendingDelete>>(PENDING_DELETES, {}));
}

export async function setPendingDelete(state: vscode.Memento, root: string, pending: PendingDelete | undefined): Promise<void> {
  const all = { ...state.get<Record<string, PendingDelete>>(PENDING_DELETES, {}) };
  if (pending) all[root] = pending;
  else delete all[root];
  await state.update(PENDING_DELETES, all);
}

interface SavedOptions {
  deleteLocal: boolean;
  deleteRemote: boolean;
  noFf: boolean;
}

const STEPS: Record<MergeStep, () => string> = {
  fetch: () => vscode.l10n.t('Fetching…'),
  checkout: () => vscode.l10n.t('Switching branch…'),
  'update-target': () => vscode.l10n.t('Updating the target branch…'),
  'update-source': () => vscode.l10n.t('Updating the source branch…'),
  merge: () => vscode.l10n.t('Merging…'),
  delete: () => vscode.l10n.t('Deleting the source branch…'),
};

export class MergeCommand implements vscode.Disposable {
  readonly #git: GitCommands;
  readonly #repos: Repos;
  readonly #state: vscode.Memento;
  readonly #command: vscode.Disposable;

  constructor(git: GitCommands, repos: Repos, state: vscode.Memento) {
    this.#git = git;
    this.#repos = repos;
    this.#state = state;
    this.#command = vscode.commands.registerCommand('gitSpark.mergeLocal', async (preset?: { root?: string; source?: string }) => {
      try {
        await this.run(preset);
      } catch (err) {
        void vscode.window.showErrorMessage(errorText(err));
      }
    });
  }

  dispose(): void {
    this.#command.dispose();
  }

  /** `preset` : dépôt et branche source déjà choisis (menu d'une branche du graphe). */
  async run(preset?: { root?: string; source?: string }): Promise<void> {
    const root = preset?.root ?? (await pickRepo(this.#repos));
    if (!root) return;
    const status = await this.#git.status(root);
    let target = status.branch.head;
    const branches = await this.#git.branches(root);
    if (!target) {
      const picked = await vscode.window.showQuickPick(branches.map((b) => ({ label: `$(git-branch) ${b.name}`, branch: b.name })), {
        title: vscode.l10n.t('Target branch'),
      });
      if (!picked) return;
      target = picked.branch;
    }
    let source: string | undefined = preset?.source;
    if (source && source === target) {
      void vscode.window.showErrorMessage(vscode.l10n.t('{0} is the current branch: pick another branch to merge into it.', source));
      return;
    }
    while (!source) {
      const into: string = target;
      const change = { label: `$(arrow-swap) ${vscode.l10n.t('Change target branch…')}`, alwaysShow: true, branch: undefined };
      const items = branches
        .filter((b) => b.name !== into)
        .map((b) => ({ label: `$(git-branch) ${b.name}`, description: b.upstream?.name, branch: b.name as string | undefined }));
      const picked = await vscode.window.showQuickPick([...items, change], {
        title: vscode.l10n.t('Merge into {0}', into),
        placeHolder: vscode.l10n.t('Branch to merge into {0}', into),
      });
      if (!picked) return;
      if (picked.branch) source = picked.branch;
      else {
        const next = await vscode.window.showQuickPick(branches.map((b) => ({ label: `$(git-branch) ${b.name}`, branch: b.name })), {
          title: vscode.l10n.t('Target branch'),
        });
        if (next) target = next.branch;
      }
    }
    const upstream = branches.find((b) => b.name === source)?.upstream;
    const saved = this.#state.get<SavedOptions>(OPTIONS, { deleteLocal: false, deleteRemote: false, noFf: false });
    type Option = vscode.QuickPickItem & { key: keyof SavedOptions };
    const options: Option[] = [{ label: vscode.l10n.t('Delete {0} after the merge', source), key: 'deleteLocal', picked: saved.deleteLocal }];
    if (upstream) options.push({ label: vscode.l10n.t('Also delete {0} on the remote', upstream.name), key: 'deleteRemote', picked: saved.deleteRemote });
    options.push({ label: vscode.l10n.t('Always create a merge commit (--no-ff)'), key: 'noFf', picked: saved.noFf });
    const chosen = await vscode.window.showQuickPick(options, {
      canPickMany: true,
      title: vscode.l10n.t('Merge {0} into {1}', source, target),
      placeHolder: vscode.l10n.t('Options — press Enter to merge'),
    });
    if (!chosen) return;
    const has = (key: keyof SavedOptions) => chosen.some((option) => option.key === key);
    const choice: SavedOptions = { deleteLocal: has('deleteLocal') || has('deleteRemote'), deleteRemote: has('deleteRemote'), noFf: has('noFf') };
    await this.#state.update(OPTIONS, choice);
    await this.execute(root, {
      source,
      target,
      noFf: choice.noFf,
      deleteSource: choice.deleteRemote ? 'remote' : choice.deleteLocal ? 'local' : 'none',
    });
  }

  /** Déroule le merge et en affiche le bilan (sans attendre les notifications). */
  async execute(root: string, options: MergeOptions): Promise<MergeOutcome | undefined> {
    const target = options.target ?? (await this.#git.status(root)).branch.head ?? '';
    let outcome: MergeOutcome;
    try {
      outcome = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Merging {0} into {1}', options.source, target) },
        (progress) => mergeLocal(this.#git, root, { ...options, target }, (step) => progress.report({ message: STEPS[step]() })),
      );
    } catch (err) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Merge failed: {0}', errorText(err)));
      return undefined;
    }
    switch (outcome.kind) {
      case 'busy':
        void vscode.window.showErrorMessage(vscode.l10n.t('An operation is in progress ({0}): finish or abort it first, {1}.', outcome.operation, whereToFinish()));
        break;
      case 'unknown-branch':
        void vscode.window.showErrorMessage(vscode.l10n.t('Unknown branch: {0}', outcome.branch));
        break;
      case 'checked-out-elsewhere':
        void vscode.window.showErrorMessage(
          vscode.l10n.t('{0} is checked out in another worktree ({1}): it cannot be updated or checked out here. Nothing was changed.', outcome.branch, outcome.path),
        );
        break;
      case 'dirty': {
        const stash = vscode.l10n.t('Stash and Merge');
        void vscode.window
          .showWarningMessage(vscode.l10n.t('You have uncommitted changes: commit or stash them before merging.'), stash)
          .then(async (choice) => {
            if (choice !== stash) return;
            try {
              await this.#git.stashPush(root, `git-spark: before merging ${options.source}`, true);
            } catch (err) {
              void vscode.window.showErrorMessage(vscode.l10n.t('Stash failed: {0}', errorText(err)));
              return;
            }
            void vscode.window.showInformationMessage(vscode.l10n.t('Your changes were stashed (untracked files included): restore them with Pop in the Stashes view, or "git stash pop".'));
            await this.execute(root, options);
          });
        break;
      }
      case 'detached':
        void vscode.window.showErrorMessage(vscode.l10n.t('HEAD is detached: choose a target branch.'));
        break;
      case 'diverged':
        void vscode.window.showErrorMessage(
          vscode.l10n.t('{0} and its remote branch have diverged: pull or rebase it first. Nothing was merged.', outcome.branch),
        );
        break;
      case 'fetch-failed':
        void vscode.window.showErrorMessage(
          vscode.l10n.t('Fetch failed: {0}. Run "git fetch" in a terminal to check the connection and credentials.', outcome.message),
        );
        break;
      case 'conflicts': {
        if (vscode.workspace.getConfiguration('gitSpark').get<boolean>('conflicts.enabled', true)) {
          // La vue Conflicts supprimera la branche quand le merge sera commité.
          const pending: PendingDelete | undefined =
            options.deleteSource === 'none'
              ? undefined
              : { root, source: options.source, target, sourceSha: outcome.sourceSha, mode: options.deleteSource };
          await setPendingDelete(this.#state, root, pending);
          void vscode.window.showWarningMessage(vscode.l10n.t('Merge conflicts: resolve them in the Conflicts view, then finish the merge.'));
          void showConflictsView();
        } else {
          void vscode.window.showWarningMessage(
            options.deleteSource === 'none'
              ? vscode.l10n.t('Merge conflicts: resolve them, then commit the merge.')
              : vscode.l10n.t('Merge conflicts: resolve them, then commit the merge. {0} was not deleted: delete it once the merge is committed.', options.source),
          );
        }
        break;
      }
      case 'merged':
        void reportMerged(this.#git, root, options.source, target, outcome);
        break;
    }
    return outcome;
  }
}

/** Bilan d'un merge réussi : suppression de branche, proposition de pousser la cible si elle a une branche distante. */
export async function reportMerged(
  git: GitCommands,
  root: string,
  source: string,
  target: string,
  outcome: { upToDate: boolean; deleted: DeleteMode; deleteError?: string },
): Promise<void> {
  if (outcome.deleteError) void vscode.window.showWarningMessage(vscode.l10n.t('{0} could not be deleted: {1}', source, outcome.deleteError));
  const parts = [outcome.upToDate ? vscode.l10n.t('{0} was already merged into {1}.', source, target) : vscode.l10n.t('Merged {0} into {1}.', source, target)];
  if (outcome.deleted === 'local') parts.push(vscode.l10n.t('{0} deleted.', source));
  if (outcome.deleted === 'remote') parts.push(vscode.l10n.t('{0} deleted locally and on the remote.', source));
  const upstream = (await git.branches(root).catch(() => [])).find((b) => b.name === target)?.upstream;
  const push = vscode.l10n.t('Push');
  const choice = await (upstream && !outcome.upToDate
    ? vscode.window.showInformationMessage(parts.join(' '), push)
    : vscode.window.showInformationMessage(parts.join(' ')));
  if (choice !== push) return;
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pushing {0}…', target) }, () =>
      upstream ? git.pushBranch(root, upstream.remote, target, upstream.ref) : Promise.resolve(),
    );
  } catch (err) {
    void vscode.window.showErrorMessage(vscode.l10n.t('Push failed: {0}', errorText(err)));
  }
}

