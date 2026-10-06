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
  // Nom complet : sans ambiguïté si une branche et un tag ont le même nom.
  for (const ref of await git.refs(root)) items.push({ label: `${icons[ref.kind]} ${ref.name}`, description: ref.sha.slice(0, 8), ref: ref.ref });
  const quickPick = vscode.window.createQuickPick<RefItem>();
  quickPick.title = title;
  quickPick.placeholder = vscode.l10n.t('Branch, tag or commit SHA');
  quickPick.items = items;
  const accepted = await new Promise<{ item?: RefItem; typed: string } | undefined>((resolve) => {
    quickPick.onDidAccept(() => {
      resolve({ item: quickPick.selectedItems[0] ?? quickPick.activeItems[0], typed: quickPick.value.trim() });
      quickPick.hide();
    });
    quickPick.onDidHide(() => resolve(undefined));
    quickPick.show();
  });
  quickPick.dispose();
  if (!accepted) return undefined;
  const { item, typed } = accepted;
  // Texte saisi qui désigne une révision (« v1 », un SHA…) : il l'emporte sur l'élément proposé par la recherche floue.
  const itemName = item?.label.replace(/^\$\([^)]+\) /, '');
  if (typed && typed !== itemName && (await git.revParse(root, typed))) return typed;
  if (item) return item.ref;
  if (typed) void vscode.window.showErrorMessage(vscode.l10n.t('Unknown reference: {0}', typed));
  return undefined;
}
