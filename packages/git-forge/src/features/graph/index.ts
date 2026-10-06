// Fonction « graph » : un onglet de graphe par dépôt, et les commandes de ses menus contextuels (webview/context).
import * as vscode from 'vscode';
import type { GitCommands } from '../../git/commands.ts';
import type { Repos } from '../../git/repos.ts';
import { pickRepo } from '../../shared/pickRepo.ts';
import { errorText } from '../merge/command.ts';
import { GraphPanel } from './panel.ts';

/** Contexte reçu d'un menu contextuel de la webview (data-vscode-context). */
interface MenuContext {
  sha?: string;
  branch?: string;
}

const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)[^\s~^:?*[\\]+(?<!\.lock)(?<![./])$/;

export class GraphFeature implements vscode.Disposable {
  readonly #git: GitCommands;
  readonly #repos: Repos;
  readonly #extensionUri: vscode.Uri;
  readonly #panels = new Map<string, GraphPanel>();
  readonly #disposables: vscode.Disposable[];
  #active: GraphPanel | undefined;

  constructor(git: GitCommands, repos: Repos, extensionUri: vscode.Uri) {
    this.#git = git;
    this.#repos = repos;
    this.#extensionUri = extensionUri;
    const command = (id: string, run: (...args: never[]) => unknown) => vscode.commands.registerCommand(id, run);
    this.#disposables = [
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
      command('gitForge.graph.copySha', (ctx: MenuContext) => (ctx?.sha ? vscode.commands.executeCommand('gitForge.copySha', { sha: ctx.sha }) : undefined)),
      command('gitForge.graph.checkoutBranch', (ctx: MenuContext) => this.#withBranch(ctx, (panel, branch) => this.#run(panel, () => this.#git.checkout(panel.root, branch)))),
      command('gitForge.graph.mergeBranch', (ctx: MenuContext) =>
        this.#withBranch(ctx, (panel, branch) => vscode.commands.executeCommand('gitForge.mergeLocal', { root: panel.root, source: branch })),
      ),
      command('gitForge.graph.deleteBranch', (ctx: MenuContext) => this.#withBranch(ctx, (panel, branch) => this.#deleteBranch(panel, branch))),
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

  #withPanel(ctx: MenuContext, run: (panel: GraphPanel, sha: string) => unknown): unknown {
    const panel = this.#active;
    if (panel && ctx?.sha) return run(panel, ctx.sha);
  }

  #withBranch(ctx: MenuContext, run: (panel: GraphPanel, branch: string) => unknown): unknown {
    const panel = this.#active;
    if (panel && ctx?.branch) return run(panel, ctx.branch);
  }

  async #run(panel: GraphPanel, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      void vscode.window.showErrorMessage(errorText(err));
    }
    await panel.reload();
  }

  async #checkoutCommit(panel: GraphPanel, sha: string): Promise<void> {
    const checkout = vscode.l10n.t('Checkout');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('Check out {0}? HEAD will be detached: create a branch to keep new commits.', sha.slice(0, 8)),
      { modal: true },
      checkout,
    );
    if (choice === checkout) await this.#run(panel, () => this.#git.checkoutDetached(panel.root, sha));
  }

  async #create(panel: GraphPanel, sha: string, kind: 'branch' | 'tag'): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: kind === 'branch' ? vscode.l10n.t('New branch at {0}', sha.slice(0, 8)) : vscode.l10n.t('New tag at {0}', sha.slice(0, 8)),
      validateInput: (value) => (BRANCH_NAME.test(value) ? undefined : vscode.l10n.t('Invalid name.')),
    });
    if (!name) return;
    await this.#run(panel, () => (kind === 'branch' ? this.#git.createBranch(panel.root, name, sha) : this.#git.createTag(panel.root, name, sha)));
  }

  async #deleteBranch(panel: GraphPanel, branch: string): Promise<void> {
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
    if (choice === remove) await this.#run(panel, () => this.#git.deleteBranch(panel.root, branch));
  }
}
