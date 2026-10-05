// Vue « Include tree » (explorateur) : pour le fichier PHP actif, ses appelants et les fichiers qu'il inclut,
// dépliables récursivement (sans boucle sur les inclusions circulaires).
import * as vscode from 'vscode';
import type { IncludeLink, IncludeTree } from '../shared/protocol.ts';

type Direction = 'includedBy' | 'includes';

type TreeNode =
  | { kind: 'group'; direction: Direction; uri: string }
  | { kind: 'file'; direction: Direction; link: IncludeLink; ancestors: string[] };

export class IncludeTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.#changed.event;
  readonly #request: (uri: string) => Promise<IncludeTree>;
  #root?: string;

  constructor(request: (uri: string) => Promise<IncludeTree>) {
    this.#request = request;
  }

  setRoot(uri: string | undefined): void {
    if (uri === this.#root) return;
    this.#root = uri;
    this.#changed.fire();
  }

  refresh(): void {
    this.#changed.fire();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const label = node.direction === 'includedBy' ? vscode.l10n.t('Included by') : vscode.l10n.t('Includes');
      return new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
    }
    const uri = vscode.Uri.parse(node.link.uri);
    const cycle = node.ancestors.includes(node.link.uri);
    const item = new vscode.TreeItem(uri, cycle ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    item.description = node.link.label;
    item.command = {
      title: vscode.l10n.t('Open'),
      command: 'vscode.open',
      arguments: [uri, { selection: new vscode.Range(node.link.line, 0, node.link.line, 0) }],
    };
    return item;
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) {
      if (!this.#root) return [];
      return [
        { kind: 'group', direction: 'includedBy', uri: this.#root },
        { kind: 'group', direction: 'includes', uri: this.#root },
      ];
    }
    const uri = node.kind === 'group' ? node.uri : node.link.uri;
    const ancestors = node.kind === 'group' ? [node.uri] : [...node.ancestors, node.link.uri];
    if (node.kind === 'file' && node.ancestors.includes(uri)) return [];
    const tree = await this.#request(uri);
    return tree[node.direction].map((link) => ({ kind: 'file', direction: node.direction, link, ancestors }));
  }
}
