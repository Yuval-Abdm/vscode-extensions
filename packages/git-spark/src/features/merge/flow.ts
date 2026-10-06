// Merge local : récupère les branches distantes, vérifie tout sans rien modifier (opération en cours, arbre de
// travail, divergences, branche extraite ailleurs), puis extrait la cible, avance la cible et la source en
// fast-forward, merge, et supprime la branche source si demandé. Sans dépendance à VS Code.
import type { GitCommands, LocalBranch, OperationKind } from '../../git/commands.ts';
import { GitError } from '../../git/runner.ts';

export type DeleteMode = 'none' | 'local' | 'remote';

export interface MergeOptions {
  source: string;
  /** Branche qui reçoit le merge ; la branche courante par défaut. */
  target?: string;
  noFf: boolean;
  deleteSource: DeleteMode;
}

export type MergeStep = 'fetch' | 'checkout' | 'update-target' | 'update-source' | 'merge' | 'delete';

export type MergeOutcome =
  | { kind: 'busy'; operation: OperationKind }
  | { kind: 'dirty' }
  | { kind: 'detached' }
  | { kind: 'unknown-branch'; branch: string }
  | { kind: 'diverged'; branch: string }
  | { kind: 'checked-out-elsewhere'; branch: string; path: string }
  | { kind: 'fetch-failed'; message: string }
  | { kind: 'conflicts'; sourceSha: string }
  | { kind: 'merged'; upToDate: boolean; deleted: DeleteMode; deleteError?: string };

/** Ligne utile d'un message d'erreur git : la première « fatal: » ou « error: », sinon la première non vide. */
export function firstLine(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /^(fatal|error):/.test(line)) ?? lines.find((line) => !/^hint:/.test(line)) ?? lines[0] ?? '';
}

type Plan = 'unchanged' | { from: string; to: string } | 'diverged';

export async function mergeLocal(
  git: GitCommands,
  root: string,
  options: MergeOptions,
  onStep: (step: MergeStep) => void = () => {},
): Promise<MergeOutcome> {
  // 1. Vérifications sans rien modifier.
  const operation = await git.operation(root);
  if (operation) return { kind: 'busy', operation: operation.kind };
  const status = await git.status(root);
  if (status.changes > 0 || status.conflicts.length > 0) return { kind: 'dirty' };
  const target = options.target ?? status.branch.head;
  if (!target) return { kind: 'detached' };
  let branches = await git.branches(root);
  for (const name of [target, options.source]) {
    if (!branches.some((b) => b.name === name)) return { kind: 'unknown-branch', branch: name };
  }
  // Seuls les remotes des deux branches sont interrogés : un autre remote injoignable ne bloque rien.
  const remotes = new Set(branches.filter((b) => b.name === target || b.name === options.source).flatMap((b) => (b.upstream ? [b.upstream.remote] : [])));
  if (remotes.size) {
    onStep('fetch');
    try {
      for (const remote of remotes) await git.fetchRemote(root, remote);
    } catch (err) {
      if (err instanceof GitError) return { kind: 'fetch-failed', message: firstLine(err.stderr) };
      throw err;
    }
    branches = await git.branches(root);
  }
  const find = (name: string) => branches.find((b) => b.name === name) as LocalBranch;
  const targetPlan = await planUpdate(git, root, find(target));
  if (targetPlan === 'diverged') return { kind: 'diverged', branch: target };
  const sourcePlan = await planUpdate(git, root, find(options.source));
  if (sourcePlan === 'diverged') return { kind: 'diverged', branch: options.source };
  const elsewhere = await git.branchesCheckedOutElsewhere(root);
  for (const [branch, plan] of [[target, targetPlan], [options.source, sourcePlan]] as const) {
    // Une branche extraite dans un autre worktree ne doit pas bouger sous ses pieds (ni être extraite ici).
    const dir = elsewhere.get(branch);
    if (dir && (plan !== 'unchanged' || branch === target)) return { kind: 'checked-out-elsewhere', branch, path: dir };
  }

  // 2. Modifications.
  if (target !== status.branch.head) {
    onStep('checkout');
    await git.checkout(root, target);
  }
  if (targetPlan !== 'unchanged') {
    onStep('update-target');
    await git.fastForward(root, targetPlan.to);
  }
  if (sourcePlan !== 'unchanged') {
    onStep('update-source');
    await git.updateBranch(root, options.source, sourcePlan.to, sourcePlan.from);
  }
  const sourceSha = sourcePlan === 'unchanged' ? find(options.source).sha : sourcePlan.to;
  onStep('merge');
  const result = await git.merge(root, options.source, { noFf: options.noFf });
  if (result === 'conflicts') return { kind: 'conflicts', sourceSha };
  const outcome: MergeOutcome = { kind: 'merged', upToDate: result === 'up-to-date', deleted: 'none' };
  if (options.deleteSource === 'none') return outcome;
  onStep('delete');
  return { ...outcome, ...(await deleteSourceBranch(git, root, options.source, options.deleteSource)) };
}

/**
 * Ce qu'il faut faire pour amener `branch` à sa branche distante : rien (pas de branche distante, à jour, ou en
 * avance : commits pas encore poussés), un fast-forward, ou rien de possible ('diverged').
 */
async function planUpdate(git: GitCommands, root: string, branch: LocalBranch): Promise<Plan> {
  if (!branch.upstream) return 'unchanged';
  const upstream = await git.revParse(root, `refs/remotes/${branch.upstream.name}`);
  if (!upstream || upstream === branch.sha || (await git.isAncestor(root, upstream, branch.sha))) return 'unchanged';
  if (!(await git.isAncestor(root, branch.sha, upstream))) return 'diverged';
  return { from: branch.sha, to: upstream };
}

/**
 * Supprime la branche source, seulement si elle est contenue dans HEAD ; sur le remote, seulement si la branche
 * distante pointe encore là où on l'a vue (--force-with-lease) et qu'elle aussi est contenue dans HEAD.
 */
export async function deleteSourceBranch(
  git: GitCommands,
  root: string,
  source: string,
  mode: DeleteMode,
): Promise<{ deleted: DeleteMode; deleteError?: string }> {
  if (mode === 'none') return { deleted: 'none' };
  const branch = (await git.branches(root)).find((b) => b.name === source);
  if (!branch) return { deleted: 'none' };
  if (!(await git.isAncestor(root, branch.sha, 'HEAD'))) return { deleted: 'none', deleteError: `${source} is not merged into HEAD` };
  try {
    await git.deleteBranch(root, source);
  } catch (err) {
    if (err instanceof GitError) return { deleted: 'none', deleteError: firstLine(err.stderr) };
    throw err;
  }
  if (mode !== 'remote' || !branch.upstream) return { deleted: 'local' };
  const remoteSha = await git.revParse(root, `refs/remotes/${branch.upstream.name}`);
  if (!remoteSha) return { deleted: 'local' }; // déjà supprimée sur le remote
  if (!(await git.isAncestor(root, remoteSha, 'HEAD'))) return { deleted: 'local', deleteError: `${branch.upstream.name} has commits that are not merged` };
  try {
    await git.pushDelete(root, branch.upstream.remote, branch.upstream.ref, remoteSha);
  } catch (err) {
    if (err instanceof GitError) return { deleted: 'local', deleteError: firstLine(err.stderr) };
    throw err;
  }
  return { deleted: 'remote' };
}

/** Suppression demandée pendant un merge resté en conflit, faite quand ce merge est commité. */
export interface PendingDelete {
  root: string;
  source: string;
  target: string;
  /** SHA de la branche source mergée : la suppression n'a lieu que si HEAD^2 est ce commit. */
  sourceSha: string;
  mode: DeleteMode;
}

/**
 * Suite d'une suppression en attente : 'wait' tant que le merge est en cours ; sinon la suppression si le merge
 * commité est bien celui de la source (même s'il a été commité ailleurs), ou 'drop' (merge abandonné, autre merge).
 */
export async function settlePendingDelete(
  git: GitCommands,
  pending: PendingDelete,
): Promise<'wait' | 'drop' | { deleted: DeleteMode; deleteError?: string }> {
  if ((await git.operation(pending.root))?.kind === 'merge') return 'wait';
  if ((await git.revParse(pending.root, 'HEAD^2')) !== pending.sourceSha) return 'drop';
  return deleteSourceBranch(git, pending.root, pending.source, pending.mode);
}
