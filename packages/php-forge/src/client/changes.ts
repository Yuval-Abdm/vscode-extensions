// Fichiers modifiés (API git intégrée de VS Code, documents non enregistrés) et contrôle avant déploiement : sans
// `vscode`, testable par `node --test`.

/** Changement de l'API git intégrée (extensions/git/src/api/git.d.ts) : seulement ce qui est lu ici. */
export interface GitChange {
  uri: { toString(): string; fsPath: string };
  status: number;
}

export interface GitState {
  mergeChanges?: GitChange[];
  indexChanges: GitChange[];
  workingTreeChanges: GitChange[];
  untrackedChanges?: GitChange[];
}

/** Statuts « supprimé » de l'API git : rien à vérifier ni à déployer */
const DELETED = new Set([2, 6]);
const PHP = /\.(php\d?|phtml|inc|ctp)$/i;

/** Fichiers modifiés (index, arbre de travail, non suivis, conflits) des dépôts, sans les suppressions ni doublon. */
export function changedFiles(states: GitState[], dirty: string[] = []): string[] {
  const out = new Set<string>();
  for (const s of states) {
    for (const list of [s.mergeChanges, s.indexChanges, s.workingTreeChanges, s.untrackedChanges]) {
      for (const c of list ?? []) if (!DELETED.has(c.status)) out.add(c.uri.toString());
    }
  }
  for (const uri of dirty) out.add(uri);
  return [...out].sort();
}

export const isPhp = (uri: string) => PHP.test(uri);

/** Message d'avertissement avant déploiement : fichiers avec des erreurs (au plus 5 nommés). */
export function errorSummary(files: { label: string; errors: number }[]): { count: number; names: string } | undefined {
  const withErrors = files.filter((f) => f.errors > 0);
  if (!withErrors.length) return undefined;
  const names = withErrors.slice(0, 5).map((f) => f.label).join(', ') + (withErrors.length > 5 ? ', …' : '');
  return { count: withErrors.length, names };
}

/** Extension git intégrée : ce qui est lu pour obtenir son API. */
export interface GitExtension<T> {
  isActive: boolean;
  exports: { enabled?: boolean; getAPI(version: 1): T } | undefined;
  activate(): Promise<{ enabled?: boolean; getAPI(version: 1): T } | undefined>;
}

/**
 * API git, ou undefined si l'extension est absente, désactivée (`git.enabled: false`) ou sans exécutable git :
 * `getAPI` lève alors « Git model not found ». Jamais d'exception (l'activation de PHP Forge continue).
 */
export async function gitApiOf<T>(ext: GitExtension<T> | undefined): Promise<T | undefined> {
  try {
    const exports = ext && (ext.isActive ? ext.exports : await ext.activate());
    if (!exports || exports.enabled === false) return undefined;
    return exports.getAPI(1);
  } catch {
    return undefined;
  }
}

/** Fichiers en conflit de fusion : jamais déployés (marqueurs <<<<<<< possibles). */
export function conflictedFiles(states: GitState[]): string[] {
  return [...new Set(states.flatMap((s) => (s.mergeChanges ?? []).map((c) => c.uri.toString())))].sort();
}

/** Cible d'un fichier selon FTP SFTP Deploy (`resolve`) : profil, serveur, chemin relatif. */
export interface DeployTarget {
  rel: string;
  profile: string;
  host: string;
}

/** Confirmation avant déploiement : nombre de fichiers, serveurs, premiers chemins. */
export function deploySummary(targets: DeployTarget[], shown = 12): { count: number; servers: string[]; paths: string[]; more: number } {
  const servers = [...new Set(targets.map((t) => `${t.profile} (${t.host})`))].sort();
  return { count: targets.length, servers, paths: targets.slice(0, shown).map((t) => t.rel), more: Math.max(0, targets.length - shown) };
}
