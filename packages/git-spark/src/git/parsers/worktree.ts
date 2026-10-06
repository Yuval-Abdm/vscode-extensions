// Analyse de `git worktree list --porcelain` : un bloc par worktree, séparés par une ligne vide.

export interface Worktree {
  path: string;
  head?: string;
  /** Branche extraite (nom court) ; absente si HEAD est détaché ou pour un dépôt nu. */
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  /** Dossier disparu : `git worktree prune` le retirerait. */
  prunable: boolean;
}

export function parseWorktrees(text: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Worktree | undefined;
  for (const line of text.split('\n')) {
    if (!line) {
      current = undefined;
      continue;
    }
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'worktree') {
      current = { path: value, detached: false, bare: false, locked: false, prunable: false };
      worktrees.push(current);
    } else if (current) {
      if (key === 'HEAD') current.head = value;
      else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'detached') current.detached = true;
      else if (key === 'bare') current.bare = true;
      else if (key === 'locked') current.locked = true;
      else if (key === 'prunable') current.prunable = true;
    }
  }
  return worktrees;
}
