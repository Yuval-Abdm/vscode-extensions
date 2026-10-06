// Dépôt d'un fichier : implémenté par Repos (API vscode.git), simulé dans les tests.
import path from 'node:path';

export interface RepoLocation {
  root: string;
  /** SHA de HEAD ; undefined dans un dépôt sans commit. */
  head: string | undefined;
}

export interface RepoLocator {
  locate(fileName: string): RepoLocation | undefined;
}

/** Chemin relatif à la racine du dépôt, séparateurs `/`. */
export function relativePath(root: string, fileName: string): string {
  return path.relative(root, fileName).split(path.sep).join('/');
}
