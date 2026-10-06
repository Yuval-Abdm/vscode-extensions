// Choix d'une référence : arbre de travail (facultatif), HEAD, branches, branches distantes, tags, ou SHA saisi.
import * as vscode from 'vscode';
import type { GitCommands } from '../git/commands.ts';

interface RefItem extends vscode.QuickPickItem {
  ref: string;
}

/** Référence choisie ; '' pour l'arbre de travail ; undefined si annulé ou invalide. */
export async function pickRef(git: GitCommands, root: string, title: string, allowWorktree: boolean): Promise<string | undefined> {
  const icons = { branch: '$(git-branch)', remote: '$(cloud)', tag: '$(tag)' };
  const items: RefItem[] = [];
  if (allowWorktree) items.push({ label: `$(edit) ${vscode.l10n.t('Working tree')}`, ref: '' });
  items.push({ label: '$(git-commit) HEAD', ref: 'HEAD' });
  for (const ref of await git.refs(root)) items.push({ label: `${icons[ref.kind]} ${ref.name}`, description: ref.sha.slice(0, 8), ref: ref.name });
  const quickPick = vscode.window.createQuickPick<RefItem>();
  quickPick.title = title;
  quickPick.placeholder = vscode.l10n.t('Branch, tag or commit SHA');
  quickPick.items = items;
  const picked = await new Promise<string | undefined>((resolve) => {
    quickPick.onDidAccept(() => {
      const item = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
      resolve(item ? item.ref : quickPick.value.trim() || undefined);
      quickPick.hide();
    });
    quickPick.onDidHide(() => resolve(undefined));
    quickPick.show();
  });
  quickPick.dispose();
  if (picked === undefined || picked === '' || items.some((item) => item.ref === picked)) return picked;
  // SHA ou référence saisie : vérifiée avant usage.
  if (await git.revParse(root, picked)) return picked;
  void vscode.window.showErrorMessage(vscode.l10n.t('Unknown reference: {0}', picked));
  return undefined;
}
