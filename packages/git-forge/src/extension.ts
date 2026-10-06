// Activation : extension Git intégrée, puis chaque fonction activée par son réglage gitForge.<fonction>.enabled.
// Rien n'est créé tant qu'aucun dépôt n'est ouvert.
import * as vscode from 'vscode';
import { BlameFeature } from './features/blame/index.ts';
import { HistoryView } from './features/history/view.ts';
import { ConflictsView } from './features/conflicts/view.ts';
import { MergeCommand } from './features/merge/command.ts';
import { CompareFeature } from './features/compare/index.ts';
import { GraphFeature } from './features/graph/index.ts';
import { GitCommands } from './git/commands.ts';
import type { API, GitExtension } from './git/gitApi.ts';
import { Repos } from './git/repos.ts';
import { GitRunner } from './git/runner.ts';
import { registerRevisionCommands, RevisionProvider, SCHEME } from './shared/revisions.ts';

/** API renvoyée par activate() (tests e2e). */
export interface GitForgeApi {
  /** Fonction créée (`blame`…), ou undefined si elle est désactivée ou pas encore créée. */
  feature<T>(key: string): T | undefined;
}

interface Services {
  git: GitCommands;
  repos: Repos;
  state: vscode.Memento;
  extensionUri: vscode.Uri;
}

const FEATURES: Record<string, (services: Services) => vscode.Disposable> = {
  blame: ({ git, repos }) => new BlameFeature(git, repos),
  history: ({ git, repos }) => new HistoryView(git, repos),
  conflicts: ({ git, repos, state }) => new ConflictsView(git, repos, state),
  merge: ({ git, repos, state }) => new MergeCommand(git, repos, state),
  compare: ({ git, repos }) => new CompareFeature(git, repos),
  graph: ({ git, repos, extensionUri }) => new GraphFeature(git, repos, extensionUri),
};

export async function activate(context: vscode.ExtensionContext): Promise<GitForgeApi> {
  const live = new Map<string, vscode.Disposable>();
  const api: GitForgeApi = { feature: <T>(key: string) => live.get(key) as T | undefined };
  context.subscriptions.push({
    dispose: () => {
      for (const feature of live.values()) feature.dispose();
      live.clear();
    },
  });

  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  const gitExtension = extension && (extension.isActive ? extension.exports : await extension.activate());
  if (!gitExtension) {
    void vscode.window.showWarningMessage(vscode.l10n.t('Git Forge needs the built-in Git extension.'));
    return api;
  }
  const start = () => {
    let gitApi: API;
    try {
      gitApi = gitExtension.getAPI(1);
    } catch {
      void vscode.window.showWarningMessage(vscode.l10n.t('Git Forge is inactive: Git was not found.'));
      return;
    }
    setup(context, gitApi, live).catch((err: unknown) => {
      void vscode.window.showErrorMessage(vscode.l10n.t('Git Forge could not start: {0}', err instanceof Error ? err.message : String(err)));
    });
  };
  if (gitExtension.enabled) start();
  else {
    void vscode.window.showWarningMessage(vscode.l10n.t('Git Forge is inactive: the built-in Git extension is disabled (git.enabled).'));
    const listener = gitExtension.onDidChangeEnablement((enabled) => {
      if (!enabled) return;
      listener.dispose();
      start();
    });
    context.subscriptions.push(listener);
  }
  return api;
}

async function setup(context: vscode.ExtensionContext, gitApi: API, live: Map<string, vscode.Disposable>): Promise<void> {
  if (gitApi.state !== 'initialized') {
    await new Promise<void>((resolve) => {
      const listener = gitApi.onDidChangeState((state) => {
        if (state !== 'initialized') return;
        listener.dispose();
        resolve();
      });
      context.subscriptions.push(listener);
    });
  }
  const git = new GitCommands(new GitRunner(gitApi.git.path));
  const repos = new Repos(gitApi);
  context.subscriptions.push(
    repos,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionProvider(git)),
    ...registerRevisionCommands(),
  );

  const apply = () => {
    const config = vscode.workspace.getConfiguration('gitForge');
    for (const [key, create] of Object.entries(FEATURES)) {
      const enabled = config.get<boolean>(`${key}.enabled`, true);
      const current = live.get(key);
      if (enabled && !current) live.set(key, create({ git, repos, state: context.workspaceState, extensionUri: context.extensionUri }));
      else if (!enabled && current) {
        current.dispose();
        live.delete(key);
      }
    }
  };
  const begin = () => {
    void vscode.commands.executeCommand('setContext', 'gitForge.active', true);
    apply();
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitForge')) apply();
      }),
    );
  };
  if (gitApi.repositories.length) begin();
  else {
    const listener = gitApi.onDidOpenRepository(() => {
      listener.dispose();
      begin();
    });
    context.subscriptions.push(listener);
  }
}

export function deactivate(): void {}
