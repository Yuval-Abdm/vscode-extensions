// Commande « Merge Locally » : choix de la branche source (et de la cible), options mémorisées, déroulé avec
// progression, puis bilan : conflits → vue Conflicts ; merge fait → proposition de pousser.
import * as vscode from 'vscode';
import type { GitCommands } from '../../git/commands.ts';
import type { Repos } from '../../git/repos.ts';
import { pickRepo } from '../../shared/pickRepo.ts';
import { firstLine, mergeLocal, type DeleteMode, type MergeOptions, type MergeOutcome, type MergeStep } from './flow.ts';
import { GitError } from '../../git/runner.ts';

/** Suppression de branche demandée pendant un merge resté en conflit : faite par « Finish » (vue Conflicts). */
export const PENDING_DELETE = 'gitForge.pendingMergeDelete';
const OPTIONS = 'gitForge.mergeOptions';

export interface PendingDelete {
  root: string;
  source: string;
  target: string;
  mode: DeleteMode;
}

interface SavedOptions {
  deleteLocal: boolean;
  deleteRemote: boolean;
  noFf: boolean;
}

const STEPS: Record<MergeStep, () => string> = {
  checkout: () => vscode.l10n.t('Switching branch…'),
  fetch: () => vscode.l10n.t('Fetching…'),
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
    this.#command = vscode.commands.registerCommand('gitForge.mergeLocal', () => this.run());
  }

  dispose(): void {
    this.#command.dispose();
  }

  async run(): Promise<void> {
    const root = await pickRepo(this.#repos);
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
    let source: string | undefined;
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
      case 'dirty': {
        const stash = vscode.l10n.t('Stash and Merge');
        void vscode.window
          .showWarningMessage(vscode.l10n.t('You have uncommitted changes: commit or stash them before merging.'), stash)
          .then(async (choice) => {
            if (choice !== stash) return;
            await this.#git.stashPush(root, `git-forge: before merging ${options.source}`);
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
        const pending: PendingDelete | undefined =
          options.deleteSource === 'none' ? undefined : { root, source: options.source, target, mode: options.deleteSource };
        await this.#state.update(PENDING_DELETE, pending);
        void vscode.window.showWarningMessage(vscode.l10n.t('Merge conflicts: resolve them in the Conflicts view, then finish the merge.'));
        if (vscode.workspace.getConfiguration('gitForge').get<boolean>('conflicts.enabled', true)) {
          void vscode.commands.executeCommand('gitForge.conflicts.focus');
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
  const hasUpstream = (await git.branches(root)).some((b) => b.name === target && b.upstream);
  const push = vscode.l10n.t('Push');
  const choice = await (hasUpstream && !outcome.upToDate
    ? vscode.window.showInformationMessage(parts.join(' '), push)
    : vscode.window.showInformationMessage(parts.join(' ')));
  if (choice !== push) return;
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pushing {0}…', target) }, () => git.push(root));
  } catch (err) {
    void vscode.window.showErrorMessage(vscode.l10n.t('Push failed: {0}', errorText(err)));
  }
}

export function errorText(err: unknown): string {
  if (err instanceof GitError) return firstLine(err.stderr) || err.message;
  return err instanceof Error ? err.message : String(err);
}
