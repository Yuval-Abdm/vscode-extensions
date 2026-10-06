// Historique : arguments de diff d'un commit pour un fichier (sans dépendance à VS Code).
import type { FileChange, LogEntry } from '../../git/parsers/log.ts';
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
