// Dépôt sur lequel agir : le seul ouvert, celui du fichier actif, ou un choix dans une liste.
import path from 'node:path';
import * as vscode from 'vscode';
import type { Repos } from '../git/repos.ts';

export async function pickRepo(repos: Repos): Promise<string | undefined> {
  const roots = repos.roots();
  if (roots.length <= 1) return roots[0];
  const editor = vscode.window.activeTextEditor;
  const active = editor?.document.uri.scheme === 'file' ? repos.locate(editor.document.fileName)?.root : undefined;
  if (active) return active;
  const picked = await vscode.window.showQuickPick(
    roots.map((root) => ({ label: path.basename(root), description: root, root })),
    { placeHolder: vscode.l10n.t('Repository') },
  );
  return picked?.root;
}

/** Dépôt de l'éditeur actif, sinon le premier dépôt ouvert. */
export function currentRoot(repos: Repos): string | undefined {
  const editor = vscode.window.activeTextEditor;
  const active = editor?.document.uri.scheme === 'file' ? repos.locate(editor.document.fileName)?.root : undefined;
  return active ?? repos.roots()[0];
}
