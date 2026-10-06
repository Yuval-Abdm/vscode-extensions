// Fonction « graph » : vue Graph de la barre latérale (conteneur Git Forge), un onglet de graphe par dépôt, et les
// commandes de leurs menus contextuels (webview/context).
import * as vscode from 'vscode';
import type { GitCommands } from '../../git/commands.ts';
import type { Repos } from '../../git/repos.ts';
import { pickRepo } from '../../shared/pickRepo.ts';
import { errorText } from '../../shared/errors.ts';
import { GraphPanel } from './panel.ts';
import { GraphSidebar } from './sidebar.ts';

/** Ce qu'utilisent les menus : un onglet ou la vue latérale. */
interface GraphHost {
  readonly root: string;
  readonly selected: string | undefined;
  reload(): Promise<void>;
}

/** Contexte reçu d'un menu contextuel de la webview (data-vscode-context). */
interface MenuContext {
  /** Identifiant de la webview d'où vient le menu (ajouté par VS Code). */
  webview?: string;
  root?: string;
  sha?: string;
  branch?: string;
  /** Branche extraite (HEAD). */
  current?: boolean;
}

export class GraphFeature implements vscode.Disposable {
  readonly #git: GitCommands;
  readonly #repos: Repos;
  readonly #extensionUri: vscode.Uri;
  readonly #panels = new Map<string, GraphPanel>();
  readonly #disposables: vscode.Disposable[];
  #active: GraphPanel | undefined;
  readonly sidebar: GraphSidebar;

  constructor(git: GitCommands, repos: Repos, extensionUri: vscode.Uri) {
    this.#git = git;
    this.#repos = repos;
    this.#extensionUri = extensionUri;
    const command = (id: string, run: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, run);
    this.sidebar = new GraphSidebar(git, repos, extensionUri, (root) => this.open(root));
    this.#disposables = [
      this.sidebar,
      vscode.window.registerWebviewViewProvider('gitForge.graphView', this.sidebar),
      command('gitForge.graphView.refresh', () => this.sidebar.session?.reload()),
      command('gitForge.showGraph', async () => {
        const root = await pickRepo(this.#repos);
        if (root) this.open(root);
      }),
      command('gitForge.graph.checkoutCommit', (ctx: MenuContext) => this.#withPanel(ctx, (panel, sha) => this.#checkoutCommit(panel, sha))),
      command('gitForge.graph.createBranch', (ctx: MenuContext) => this.#withPanel(ctx, (panel, sha) => this.#create(panel, sha, 'branch'))),
      command('gitForge.graph.createTag', (ctx: MenuContext) => this.#withPanel(ctx, (panel, sha) => this.#create(panel, sha, 'tag'))),
      command('gitForge.graph.compareWithHead', (ctx: MenuContext) =>
        this.#withPanel(ctx, async (panel, sha) => {
          await vscode.commands.executeCommand('gitForge.compare.show', { root: panel.root, left: sha, right: 'HEAD', mode: 'direct' });
          await vscode.commands.executeCommand('gitForge.compare.focus');
        }),
      ),
      command('gitForge.graph.compareWithSelected', (ctx: MenuContext) =>
        this.#withPanel(ctx, async (panel, sha) => {
          const selected = panel.selected;
          if (!selected || selected === sha) {
            void vscode.window.showInformationMessage(vscode.l10n.t('Select a commit first (click), then right-click another one to compare them.'));
            return;
          }
          await vscode.commands.executeCommand('gitForge.compare.show', { root: panel.root, left: selected, right: sha, mode: 'direct' });
          await vscode.commands.executeCommand('gitForge.compare.focus');
        }),
      ),
      command('gitForge.graph.copySha', (ctx: MenuContext) => (ctx?.sha ? vscode.commands.executeCommand('gitForge.copySha', { sha: ctx.sha }) : undefined)),
      command('gitForge.graph.checkoutBranch', (ctx: MenuContext) => this.#withBranch(ctx, (panel, branch) => this.#run(panel, () => this.#git.checkout(panel.root, branch)))),
      command('gitForge.graph.mergeBranch', (ctx: MenuContext) =>
        this.#withBranch(ctx, (panel, branch) => vscode.commands.executeCommand('gitForge.mergeLocal', { root: panel.root, source: branch })),
      ),
      command('gitForge.graph.deleteBranch', (ctx: MenuContext) =>
        this.#withBranch(ctx, (panel, branch) => {
          if (ctx.current) {
            void vscode.window.showErrorMessage(vscode.l10n.t('{0} is the current branch: check out another branch before deleting it.', branch));
            return;
          }
          return this.#run(panel, () => this.#deleteBranch(panel, branch));
        }),
      ),
    ];
  }

  /** Dernier graphe ouvert ou actif (tests e2e). */
  get panel(): GraphPanel | undefined {
    return this.#active;
  }

  dispose(): void {
    for (const panel of [...this.#panels.values()]) panel.dispose();
    for (const disposable of this.#disposables) disposable.dispose();
  }

  open(root: string): GraphPanel {
    const existing = this.#panels.get(root);
    if (existing) {
      existing.panel.reveal();
      this.#active = existing;
      return existing;
    }
    const panel = new GraphPanel(this.#git, this.#repos, root, this.#extensionUri, () => {
      this.#panels.delete(root);
      if (this.#active === panel) this.#active = undefined;
    });
    panel.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) this.#active = panel;
    });
    this.#panels.set(root, panel);
    this.#active = panel;
    return panel;
  }

  /** Graphe d'où vient le menu : celui du dépôt `ctx.root`, sinon le dernier actif. */
  #panelOf(ctx: MenuContext): GraphHost | undefined {
    const side = this.sidebar.session;
    if (ctx?.root) {
      // Menu de la vue latérale, sinon de l'onglet du dépôt ctx.root.
      if (ctx.webview === 'gitForge.graphView' && side?.root === ctx.root) return side;
      const tab = this.#panels.get(ctx.root);
      if (tab) return tab;
      if (side?.root === ctx.root) return side;
    }
    return this.#active ?? side;
  }

  #withPanel(ctx: MenuContext, run: (panel: GraphHost, sha: string) => unknown): unknown {
    const panel = this.#panelOf(ctx);
    if (panel && ctx?.sha) return run(panel, ctx.sha);
  }

  #withBranch(ctx: MenuContext, run: (panel: GraphHost, branch: string) => unknown): unknown {
    const panel = this.#panelOf(ctx);
    if (panel && ctx?.branch) return run(panel, ctx.branch);
  }

  async #run(panel: GraphHost, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      void vscode.window.showErrorMessage(errorText(err));
    }
    await panel.reload();
  }

  async #checkoutCommit(panel: GraphHost, sha: string): Promise<void> {
    const checkout = vscode.l10n.t('Checkout');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('Check out {0}? HEAD will be detached: create a branch to keep new commits.', sha.slice(0, 8)),
      { modal: true },
      checkout,
    );
    if (choice === checkout) await this.#run(panel, () => this.#git.checkoutDetached(panel.root, sha));
  }

  async #create(panel: GraphHost, sha: string, kind: 'branch' | 'tag'): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: kind === 'branch' ? vscode.l10n.t('New branch at {0}', sha.slice(0, 8)) : vscode.l10n.t('New tag at {0}', sha.slice(0, 8)),
      // Nom vérifié par git lui-même (check-ref-format).
      validateInput: async (value) => ((await this.#git.validRefName(panel.root, value, kind)) ? undefined : vscode.l10n.t('Invalid name.')),
    });
    if (!name) return;
    await this.#run(panel, () => (kind === 'branch' ? this.#git.createBranch(panel.root, name, sha) : this.#git.createTag(panel.root, name, sha)));
  }

  async #deleteBranch(panel: GraphHost, branch: string): Promise<void> {
    const sha = await this.#git.revParse(panel.root, `refs/heads/${branch}`);
    if (!sha) return;
    const merged = await this.#git.isAncestor(panel.root, sha, 'HEAD');
    const remove = vscode.l10n.t('Delete');
    const choice = await vscode.window.showWarningMessage(
      merged
        ? vscode.l10n.t('Delete the branch {0}? It is merged into HEAD.', branch)
        : vscode.l10n.t('Delete the branch {0}? It is NOT merged into HEAD: its commits will only be reachable through the reflog.', branch),
      { modal: true },
      remove,
    );
    if (choice === remove) await this.#git.deleteBranch(panel.root, branch);
  }
}
