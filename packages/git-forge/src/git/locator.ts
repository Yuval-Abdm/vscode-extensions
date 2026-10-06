// Dépôt d'un fichier : implémenté par Repos (API vscode.git), simulé dans les tests.

export interface RepoLocation {
  root: string;
  /** SHA de HEAD ; undefined dans un dépôt sans commit. */
  head: string | undefined;
}

export interface RepoLocator {
  locate(fileName: string): RepoLocation | undefined;
}
