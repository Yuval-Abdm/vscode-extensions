// Onglet éditeur du graphe d'un dépôt : héberge une GraphSession dans un WebviewPanel.
import path from 'node:path';
import * as vscode from 'vscode';
import type { GitCommands } from '../../git/commands.ts';
import type { Repos } from '../../git/repos.ts';
import { GraphSession, type GraphRowData } from './session.ts';

export type { GraphRowData } from './session.ts';

export class GraphPanel implements vscode.Disposable {
  readonly panel: vscode.WebviewPanel;
  readonly session: GraphSession;

  constructor(git: GitCommands, repos: Repos, root: string, extensionUri: vscode.Uri, onDispose: () => void) {
    this.panel = vscode.window.createWebviewPanel('gitForge.graph', vscode.l10n.t('Graph: {0}', path.basename(root)), vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    this.session = new GraphSession(git, repos, this.panel.webview, root, extensionUri, { sidebar: false });
    this.panel.onDidDispose(() => {
      this.session.dispose();
      onDispose();
    });
  }

  get root(): string {
    return this.session.root;
  }

  /** Lignes chargées (tests e2e). */
  get rows(): readonly GraphRowData[] {
    return this.session.rows;
  }

  get selected(): string | undefined {
    return this.session.selected;
  }

  reload(): Promise<void> {
    return this.session.reload();
  }

  dispose(): void {
    this.panel.dispose();
  }
}
