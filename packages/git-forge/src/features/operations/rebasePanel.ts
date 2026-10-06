// Webview de l'éditeur de rebase : liste modifiable, rendue à l'appelant quand l'utilisateur valide (« start ») ou
// abandonne (onglet fermé, « cancel »). Deux usages : rebase lancé par Git Spark (messages modifiables) et fichier
// git-rebase-todo d'un `git rebase -i` lancé ailleurs (éditeur personnalisé, actions seulement).
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { whereToFinish } from '../../shared/errors.ts';
import type { RebaseItem } from './rebaseModel.ts';

type Incoming = { type: 'ready' } | { type: 'start'; items: RebaseItem[] } | { type: 'cancel' };

/**
 * Remplit `panel` avec l'éditeur ; résout avec la liste validée, 'abort' (bouton Annuler / Abandonner) ou undefined
 * (onglet fermé sans décision).
 */
export function runRebaseEditor(
  panel: vscode.WebviewPanel,
  extensionUri: vscode.Uri,
  title: string,
  items: RebaseItem[],
  editMessages: boolean,
): Promise<RebaseItem[] | 'abort' | undefined> {
  const media = vscode.Uri.joinPath(extensionUri, 'media');
  panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
  panel.webview.html = html(panel.webview, media, title, editMessages);
  return new Promise((resolve) => {
    const subscriptions = [
      panel.webview.onDidReceiveMessage((message: Incoming) => {
        if (message.type === 'ready') void panel.webview.postMessage({ type: 'items', items, editMessages });
        else if (message.type === 'start') done(message.items);
        else done('abort');
      }),
      panel.onDidDispose(() => done(undefined)),
    ];
    let settled = false;
    function done(result: RebaseItem[] | 'abort' | undefined): void {
      if (settled) return;
      settled = true;
      for (const subscription of subscriptions) subscription.dispose();
      resolve(result);
    }
  });
}

export function openRebasePanel(extensionUri: vscode.Uri, title: string, items: RebaseItem[]): Promise<RebaseItem[] | undefined> {
  const panel = vscode.window.createWebviewPanel('gitForge.rebase', title, vscode.ViewColumn.Active, {});
  panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
  return runRebaseEditor(panel, extensionUri, title, items, true)
    .then((result) => (result === 'abort' ? undefined : result))
    .finally(() => panel.dispose());
}

function html(webview: vscode.Webview, media: vscode.Uri, title: string, editMessages: boolean): string {
  const nonce = randomBytes(16).toString('base64');
  const text = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const strings = {
    actions: {
      pick: vscode.l10n.t('pick — keep'),
      reword: vscode.l10n.t('reword — keep, change the message'),
      edit: vscode.l10n.t('edit — stop to amend'),
      squash: vscode.l10n.t('squash — merge into the previous, combine messages'),
      fixup: vscode.l10n.t('fixup — merge into the previous, drop the message'),
      drop: vscode.l10n.t('drop — remove'),
    },
    errors: {
      empty: vscode.l10n.t('Every commit is dropped: there is nothing to rebase.'),
      squashFirst: vscode.l10n.t('The first kept commit cannot be squash or fixup.'),
    },
  };
  const json = JSON.stringify(strings).replace(/</g, '\\u003c');
  const note = editMessages
    ? vscode.l10n.t('Oldest commit at the top. Drag the handle to reorder. Uncommitted changes are stashed and restored. If the rebase stops (conflict, edit), finish it {0}.', whereToFinish())
    : vscode.l10n.t('Oldest commit at the top. Drag the handle to reorder. Messages of reword and squash are asked by git afterwards.');
  return `<!DOCTYPE html>
<html lang="${text(vscode.env.language)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(media, 'rebase.css'))}">
</head>
<body>
<h1>${text(title)}</h1>
<p class="note">${text(note)}</p>
<div id="items"></div>
<div id="error" class="error"></div>
<div class="buttons">
  <button id="start">${text(editMessages ? vscode.l10n.t('Start Rebase') : vscode.l10n.t('Save and Continue'))}</button>
  <button id="cancel" class="secondary">${text(editMessages ? vscode.l10n.t('Cancel') : vscode.l10n.t('Abort Rebase'))}</button>
</div>
<script id="strings" type="application/json">${json}</script>
<script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(media, 'rebase.js'))}"></script>
</body>
</html>`;
}
