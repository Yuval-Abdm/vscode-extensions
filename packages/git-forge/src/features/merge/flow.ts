// Merge local : met à jour la cible et la source depuis leur branche distante (fast-forward uniquement), merge,
// puis supprime la branche source si demandé. Sans dépendance à VS Code.
import type { GitCommands } from '../../git/commands.ts';
import { GitError } from '../../git/runner.ts';

export type DeleteMode = 'none' | 'local' | 'remote';

export interface MergeOptions {
  source: string;
  /** Branche qui reçoit le merge ; la branche courante par défaut. */
  target?: string;
  noFf: boolean;
  deleteSource: DeleteMode;
}

export type MergeStep = 'checkout' | 'fetch' | 'update-target' | 'update-source' | 'merge' | 'delete';

export type MergeOutcome =
  | { kind: 'dirty' }
  | { kind: 'detached' }
  | { kind: 'diverged'; branch: string }
  | { kind: 'fetch-failed'; message: string }
  | { kind: 'conflicts' }
  | { kind: 'merged'; upToDate: boolean; deleted: DeleteMode; deleteError?: string };

/** Première ligne utile d'un message d'erreur git (« fatal: … », « error: … »). */
export function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

export async function mergeLocal(
  git: GitCommands,
  root: string,
  options: MergeOptions,
  onStep: (step: MergeStep) => void = () => {},
): Promise<MergeOutcome> {
  const status = await git.status(root);
  if (status.changes > 0 || status.conflicts.length > 0) return { kind: 'dirty' };
  const target = options.target ?? status.branch.head;
  if (!target) return { kind: 'detached' };
  if (target !== status.branch.head) {
    onStep('checkout');
    await git.checkout(root, target);
  }
  if ((await git.remotes(root)).length) {
    onStep('fetch');
    try {
      await git.fetchAll(root);
    } catch (err) {
      if (err instanceof GitError) return { kind: 'fetch-failed', message: firstLine(err.stderr) };
      throw err;
    }
  }
  onStep('update-target');
  if ((await updateFromUpstream(git, root, target, true)) === 'diverged') return { kind: 'diverged', branch: target };
  onStep('update-source');
  if ((await updateFromUpstream(git, root, options.source, false)) === 'diverged') return { kind: 'diverged', branch: options.source };
  onStep('merge');
  const result = await git.merge(root, options.source, { noFf: options.noFf });
  if (result === 'conflicts') return { kind: 'conflicts' };
  const outcome: MergeOutcome = { kind: 'merged', upToDate: result === 'up-to-date', deleted: 'none' };
  if (options.deleteSource === 'none') return outcome;
  onStep('delete');
  return { ...outcome, ...(await deleteSourceBranch(git, root, options.source, options.deleteSource)) };
}

/**
 * Avance `branch` jusqu'à sa branche distante quand c'est un fast-forward. Rien à faire sans branche distante, ou si
 * la branche est à jour ou en avance (commits pas encore poussés). 'diverged' si les deux ont des commits propres.
 */
async function updateFromUpstream(git: GitCommands, root: string, branch: string, checkedOut: boolean): Promise<'updated' | 'unchanged' | 'diverged'> {
  // « refs/heads/x@{upstream} » n'est pas compris par git : nom court de la branche.
  const upstream = await git.revParse(root, `${branch}@{upstream}`);
  const local = await git.revParse(root, `refs/heads/${branch}`);
  if (!upstream || !local || local === upstream || (await git.isAncestor(root, upstream, local))) return 'unchanged';
  if (!(await git.isAncestor(root, local, upstream))) return 'diverged';
  if (checkedOut) await git.fastForward(root, upstream);
  else await git.updateBranch(root, branch, upstream, local);
  return 'updated';
}

/** Supprime la branche source (déjà mergée), et sa branche distante si `mode` est 'remote'. */
export async function deleteSourceBranch(
  git: GitCommands,
  root: string,
  source: string,
  mode: DeleteMode,
): Promise<{ deleted: DeleteMode; deleteError?: string }> {
  if (mode === 'none') return { deleted: 'none' };
  const branch = (await git.branches(root)).find((b) => b.name === source);
  try {
    await git.deleteBranch(root, source);
  } catch (err) {
    if (err instanceof GitError) return { deleted: 'none', deleteError: firstLine(err.stderr) };
    throw err;
  }
  if (mode !== 'remote' || !branch?.upstream) return { deleted: 'local' };
  try {
    await git.pushDelete(root, branch.upstream.remote, branch.upstream.ref.replace(/^refs\/heads\//, ''));
  } catch (err) {
    if (err instanceof GitError) return { deleted: 'local', deleteError: firstLine(err.stderr) };
    throw err;
  }
  return { deleted: 'remote' };
}
