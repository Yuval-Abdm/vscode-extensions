// Fonction « compare » : vues Compare, Stashes et Worktrees (même réglage gitSpark.compare.enabled).
import type * as vscode from 'vscode';
import type { GitCommands } from '../../git/commands.ts';
import type { Repos } from '../../git/repos.ts';
import { CompareView } from './compareView.ts';
import { StashView } from './stashView.ts';
import { WorktreeView } from './worktreeView.ts';

export class CompareFeature implements vscode.Disposable {
  readonly compare: CompareView;
  readonly stashes: StashView;
  readonly worktrees: WorktreeView;

  constructor(git: GitCommands, repos: Repos) {
    this.compare = new CompareView(git, repos);
    this.stashes = new StashView(git, repos);
    this.worktrees = new WorktreeView(git, repos);
  }

  dispose(): void {
    this.compare.dispose();
    this.stashes.dispose();
    this.worktrees.dispose();
  }
}
