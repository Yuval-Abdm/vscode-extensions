// Référence d'un fichier à un commit, sérialisée dans la query des URI `git-forge:`.

export interface RevisionRef {
  /** Racine du dépôt. */
  root: string;
  /** Chemin relatif à la racine, séparateurs `/`. */
  path: string;
  /** Commit ; '' pour un fichier vide (pas de version précédente). */
  sha: string;
}

export function encodeRevision(ref: RevisionRef): string {
  return JSON.stringify({ root: ref.root, path: ref.path, sha: ref.sha });
}

export function decodeRevision(query: string): RevisionRef | undefined {
  try {
    const value = JSON.parse(query);
    if (typeof value?.root === 'string' && typeof value.path === 'string' && typeof value.sha === 'string') {
      return { root: value.root, path: value.path, sha: value.sha };
    }
  } catch {
    // query illisible
  }
  return undefined;
}
