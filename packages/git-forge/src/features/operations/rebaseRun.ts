// Lancement d'un rebase interactif (sans dépendance à VS Code) : messages et liste de tâches écrits dans un dossier
// temporaire, puis `git rebase -i`. Le dossier reste en place si le rebase s'arrête : les exec suivants le lisent.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GitCommands, RebaseCommit } from '../../git/commands.ts';
import { buildTodo, validateRebase, type RebaseItem } from './rebaseModel.ts';

export function itemsFromCommits(commits: readonly RebaseCommit[]): RebaseItem[] {
  return commits.map((commit) => ({ sha: commit.sha, summary: commit.summary, message: commit.message, action: 'pick' }));
}

/** Chemin utilisable dans une commande sh (git exécute exec et GIT_SEQUENCE_EDITOR avec sh, y compris sous Windows). */
function shellPath(file: string): string {
  return file.replace(/\\/g, '/');
}

export async function runInteractiveRebase(git: GitCommands, root: string, base: string, items: readonly RebaseItem[]): Promise<'done' | 'stopped'> {
  const invalid = validateRebase(items);
  if (invalid) throw new Error(invalid === 'empty' ? 'empty rebase: every commit is dropped' : 'squash or fixup cannot come first');
  const dir = mkdtempSync(path.join(tmpdir(), 'git-forge-rebase-'));
  let result: 'done' | 'stopped' | undefined;
  try {
    const todo = buildTodo(items, (index, message) => {
      const file = path.join(dir, `message-${index}.txt`);
      writeFileSync(file, `${message.trimEnd()}\n`);
      return shellPath(file);
    });
    const todoFile = path.join(dir, 'git-rebase-todo');
    writeFileSync(todoFile, `${todo}\n`);
    result = await git.rebaseInteractive(root, base, todoFile);
    return result;
  } finally {
    if (result !== 'stopped') rmSync(dir, { recursive: true, force: true });
  }
}
