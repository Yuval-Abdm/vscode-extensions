// Lancement d'un rebase interactif (sans dépendance à VS Code). Messages, scripts et liste de tâches sont écrits dans
// le dossier .git du dépôt (git-forge-rebase-*) : ils doivent survivre à un arrêt (les exec suivants les lisent après
// « Finish »). Les dossiers d'un rebase terminé sont supprimés au rebase suivant.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GitCommands, RebaseCommit } from '../../git/commands.ts';
import { amendScript, buildTodo, validateRebase, type RebaseItem } from './rebaseModel.ts';

export function itemsFromCommits(commits: readonly RebaseCommit[]): RebaseItem[] {
  return commits.map((commit) => ({ sha: commit.sha, summary: commit.summary, message: commit.message, ident: commit.ident, action: 'pick' }));
}

/** Chemin utilisable dans une commande sh (git exécute exec et GIT_SEQUENCE_EDITOR avec sh, y compris sous Windows). */
function shellPath(file: string): string {
  return file.replace(/\\/g, '/');
}

/** État attendu au lancement : celui de l'ouverture de l'éditeur (HEAD et branche n'ont pas changé entre-temps). */
export interface RebaseGuard {
  head: string;
  branch: string | undefined;
}

export class RebaseChangedError extends Error {
  constructor() {
    super('The branch changed since the rebase editor was opened: reopen it.');
    this.name = 'RebaseChangedError';
  }
}

export async function runInteractiveRebase(
  git: GitCommands,
  root: string,
  base: string,
  items: readonly RebaseItem[],
  guard?: RebaseGuard,
): Promise<'done' | 'stopped' | 'autostash-conflicts'> {
  const invalid = validateRebase(items);
  if (invalid) throw new Error(invalid === 'empty' ? 'empty rebase: every commit is dropped' : 'squash or fixup cannot come first');
  if (await git.operation(root)) throw new RebaseChangedError();
  const branch = (await git.status(root)).branch.head;
  if (guard && ((await git.revParse(root, 'HEAD')) !== guard.head || branch !== guard.branch)) throw new RebaseChangedError();

  const gitDir = await git.gitDir(root);
  // Aucun rebase en cours : les dossiers des rebases précédents ne servent plus.
  for (const name of readdirSync(gitDir)) {
    if (name.startsWith('git-forge-rebase-')) rmSync(path.join(gitDir, name), { recursive: true, force: true });
  }
  const dir = path.join(gitDir, `git-forge-rebase-${Date.now()}`);
  mkdirSync(dir);
  let result: 'done' | 'stopped' | 'autostash-conflicts' | undefined;
  try {
    const todo = buildTodo(items, (amend) => {
      const messageFile = path.join(dir, `message-${amend.index}.txt`);
      const expectedFile = path.join(dir, `expected-${amend.index}.txt`);
      const script = path.join(dir, `amend-${amend.index}.sh`);
      writeFileSync(messageFile, `${amend.message}\n`);
      writeFileSync(expectedFile, `${amend.expected}\n`);
      writeFileSync(script, amendScript(amend, shellPath(messageFile), shellPath(expectedFile)));
      return shellPath(script);
    });
    const todoFile = path.join(dir, 'git-rebase-todo');
    writeFileSync(todoFile, `${todo}\n`);
    result = await git.rebaseInteractive(root, base, shellPath(todoFile), branch);
    return result;
  } finally {
    if (result !== 'stopped') rmSync(dir, { recursive: true, force: true });
  }
}
