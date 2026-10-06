// Historique : arguments de diff d'un commit pour un fichier (sans dépendance à VS Code).
import type { FileChange, Hunk, LogEntry } from '../../git/parsers/log.ts';
import type { CommitFileArgs } from '../../shared/revisionRef.ts';

/** Diff d'un fichier modifié par un commit, de son premier parent vers lui. */
export function changeDiffArgs(root: string, sha: string, parent: string | undefined, change: FileChange): CommitFileArgs {
  const args: CommitFileArgs = { root, sha, path: change.path };
  if (change.status !== 'A' && parent !== undefined) {
    args.previousSha = parent;
    args.previousPath = change.oldPath ?? change.path;
  }
  if (change.status === 'D') args.deleted = true;
  return args;
}

/** Diff du fichier suivi dans un commit de l'historique ; un merge ne liste pas de fichier : chemin suivi. */
export function entryDiffArgs(root: string, entry: LogEntry, trackedPath: string): CommitFileArgs {
  return changeDiffArgs(root, entry.sha, entry.parents[0], entry.files[0] ?? { status: 'M', path: trackedPath });
}

/** Ligne de HEAD qui correspond à la ligne `line` de l'éditeur (1-based) ; undefined si elle n'est pas commitée. */
function toHead(hunks: readonly Hunk[], line: number): number | undefined {
  let offset = 0;
  for (const hunk of hunks) {
    if (hunk.newCount > 0 && line >= hunk.newStart && line < hunk.newStart + hunk.newCount) return undefined;
    const after = hunk.newCount > 0 ? line >= hunk.newStart + hunk.newCount : line > hunk.newStart;
    if (!after) break;
    offset += hunk.oldCount - hunk.newCount;
  }
  return line + offset;
}

/**
 * Lignes de HEAD correspondant à la sélection `start`–`end` de l'éditeur (1-based), réduite à ses lignes commitées ;
 * undefined si aucune ne l'est.
 */
export function mapToHead(hunks: readonly Hunk[], start: number, end: number): { start: number; end: number } | undefined {
  const mapped: number[] = [];
  for (let line = start; line <= end; line++) {
    const head = toHead(hunks, line);
    if (head !== undefined) mapped.push(head);
  }
  return mapped.length ? { start: Math.min(...mapped), end: Math.max(...mapped) } : undefined;
}
