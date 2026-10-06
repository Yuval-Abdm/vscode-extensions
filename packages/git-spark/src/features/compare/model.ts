// Comparaison : arbre des fichiers modifiés et côtés de chaque diff (sans dépendance à VS Code).
import type { FileChange } from '../../git/parsers/log.ts';
import type { RevisionRef } from '../../shared/revisionRef.ts';

export interface FolderEntry {
  kind: 'folder';
  /** Nom affiché ; « a/b » quand un dossier n'a qu'un sous-dossier. */
  name: string;
  /** Chemin relatif à la racine du dépôt. */
  path: string;
  children: TreeEntry[];
}

export interface FileEntry {
  kind: 'file';
  name: string;
  change: FileChange;
}

export type TreeEntry = FolderEntry | FileEntry;

export function buildFileTree(changes: readonly FileChange[]): TreeEntry[] {
  const root: FolderEntry = { kind: 'folder', name: '', path: '', children: [] };
  for (const change of changes) {
    const parts = change.path.split('/');
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      let next = folder.children.find((child): child is FolderEntry => child.kind === 'folder' && child.name === part);
      if (!next) {
        next = { kind: 'folder', name: part, path: folder.path ? `${folder.path}/${part}` : part, children: [] };
        folder.children.push(next);
      }
      folder = next;
    }
    folder.children.push({ kind: 'file', name: parts[parts.length - 1], change });
  }
  return arrange(root.children);
}

function arrange(entries: TreeEntry[]): TreeEntry[] {
  return entries
    .map((entry) => (entry.kind === 'folder' ? compact(entry) : entry))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1));
}

function compact(folder: FolderEntry): FolderEntry {
  let current = folder;
  while (current.children.length === 1 && current.children[0].kind === 'folder') {
    const child: FolderEntry = current.children[0];
    current = { kind: 'folder', name: `${current.name}/${child.name}`, path: child.path, children: child.children };
  }
  return { ...current, children: arrange(current.children) };
}

export interface DiffSides {
  left: RevisionRef;
  /** 'worktree' : le fichier réel (éditable). */
  right: RevisionRef | 'worktree';
}

/** Côtés du diff d'un fichier entre `base` et `right` (arbre de travail si undefined) ; sha '' = côté vide. */
export function diffSides(root: string, base: string, right: string | undefined, change: FileChange): DiffSides {
  const left: RevisionRef = { root, path: change.oldPath ?? change.path, sha: change.status === 'A' ? '' : base };
  if (change.status === 'D') return { left, right: { root, path: change.path, sha: '' } };
  return { left, right: right === undefined ? 'worktree' : { root, path: change.path, sha: right } };
}
