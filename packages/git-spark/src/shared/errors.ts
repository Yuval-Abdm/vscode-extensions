// Messages d'erreur montrés à l'utilisateur : erreurs git courantes traduites (git parle anglais : LC_ALL=C), sinon la
// ligne utile de la sortie d'erreur ; et où terminer une opération en conflit selon que la vue Conflicts est active.
import * as vscode from 'vscode';
import { firstLine } from '../features/merge/flow.ts';
import { GitError, TimeoutError } from '../git/runner.ts';

export function errorText(err: unknown): string {
  if (err instanceof TimeoutError) return vscode.l10n.t('Git did not answer in time (network, or a credentials prompt?). Try the same command in a terminal.');
  if (err instanceof GitError) {
    const raw = err.stderr;
    if (/index\.lock/.test(raw)) {
      return vscode.l10n.t('Another Git process is using this repository (index.lock). Wait for it to finish, or delete .git/index.lock if no Git command is running.');
    }
    if (/Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled/i.test(raw)) {
      return vscode.l10n.t('Authentication failed: run the command once in a terminal to enter or store your credentials.');
    }
    if (/would be overwritten/i.test(raw)) return vscode.l10n.t('Local changes would be overwritten: commit or stash them first.');
    if (/non-fast-forward|\[rejected\]|fetch first/i.test(raw)) return vscode.l10n.t('The remote branch has new commits: pull them first.');
    if (/not something we can merge|unknown revision|bad revision/i.test(raw)) return vscode.l10n.t('Unknown branch or commit.');
    return firstLine(raw) || err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export function conflictsViewEnabled(): boolean {
  return vscode.workspace.getConfiguration('gitSpark').get<boolean>('conflicts.enabled', true);
}

/** « dans la vue Conflits », ou « avec Git » quand la vue est désactivée. */
export function whereToFinish(): string {
  return conflictsViewEnabled() ? vscode.l10n.t('in the Conflicts view') : vscode.l10n.t('with Git (Source Control view or terminal)');
}

/** Affiche la vue Conflicts (relue d'abord : son contexte de visibilité doit être à jour). */
export async function showConflictsView(): Promise<void> {
  if (!conflictsViewEnabled()) return;
  await vscode.commands.executeCommand('gitSpark.conflicts.refresh');
  await vscode.commands.executeCommand('gitSpark.conflicts.focus');
}
