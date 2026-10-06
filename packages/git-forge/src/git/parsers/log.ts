// Analyse de `git log --format=LOG_FORMAT`, suivi de `--name-status` (historique d'un fichier) ou du patch de `-L`
// (historique de lignes : on lit l'en-tête du premier diff pour connaître le chemin à ce commit).
import { unquotePath } from './paths.ts';

export interface FileChange {
  /** A (ajouté), M (modifié), D (supprimé), R (renommé), C (copié), T (type changé), U (non fusionné). */
  status: string;
  path: string;
  /** Ancien chemin d'un renommage ou d'une copie. */
  oldPath?: string;
}

export interface LogEntry {
  sha: string;
  parents: string[];
  author: string;
  authorMail: string;
  /** Secondes depuis l'époque Unix. */
  authorTime: number;
  summary: string;
  files: FileChange[];
}

/**
 * Un enregistrement par commit : sept champs séparés par NUL (un message ne peut pas en contenir), le dernier étant
 * la sortie --name-status ou le patch qui suit l'en-tête.
 */
export const LOG_FORMAT = '%x00%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00';

/** Statut simple (« M ») ou combiné d'un merge (« MM », --cc) : on garde le premier. */
const NAME_STATUS = /^([ACDMRTUX])[ACDMRTUX]*\d*\t([^\t]+)(?:\t(.+))?$/;

export function parseNameStatusLine(line: string): FileChange | undefined {
  const match = NAME_STATUS.exec(line);
  if (!match) return undefined;
  if (match[3] !== undefined) return { status: match[1], path: unquotePath(match[3]), oldPath: unquotePath(match[2]) };
  return { status: match[1], path: unquotePath(match[2]) };
}

export function parseNameStatus(text: string): FileChange[] {
  return text.split('\n').flatMap((line) => parseNameStatusLine(line) ?? []);
}

export function parseLog(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  const fields = text.split('\0');
  for (let i = 1; i + 5 < fields.length; i += 7) {
    const [sha, parents, author, authorMail, authorTime, summary] = fields.slice(i, i + 6);
    entries.push({
      sha,
      parents: parents ? parents.split(' ') : [],
      author,
      authorMail,
      authorTime: Number(authorTime),
      summary,
      files: parseChanges(fields[i + 6] ?? ''),
    });
  }
  return entries;
}

function parseChanges(text: string): FileChange[] {
  const files: FileChange[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) {
      const change = patchChange(lines, i + 1);
      return change ? [change] : [];
    }
    const change = parseNameStatusLine(lines[i]);
    if (change) files.push(change);
  }
  return files;
}

/** Changement décrit par les en-têtes « --- a/… » / « +++ b/… » qui suivent une ligne « diff --git ». */
function patchChange(lines: string[], from: number): FileChange | undefined {
  let oldPath: string | null | undefined;
  for (let i = from; i < Math.min(lines.length, from + 8); i++) {
    const line = lines[i];
    if (line.startsWith('--- ')) oldPath = headerPath(line.slice(4), 'a/');
    else if (line.startsWith('+++ ') && oldPath !== undefined) {
      const newPath = headerPath(line.slice(4), 'b/');
      if (oldPath === null && newPath !== null) return { status: 'A', path: newPath };
      if (newPath === null && oldPath !== null) return { status: 'D', path: oldPath };
      if (oldPath !== null && newPath !== null) return oldPath === newPath ? { status: 'M', path: newPath } : { status: 'R', path: newPath, oldPath };
      return undefined;
    }
  }
  return undefined;
}

/** Chemin d'un en-tête de diff, sans préfixe ; null pour /dev/null. git ajoute une tabulation après un chemin avec espace. */
function headerPath(raw: string, prefix: string): string | null {
  const text = raw.replace(/\t$/, '');
  if (text === '/dev/null') return null;
  const path = unquotePath(text);
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Bloc modifié d'un diff -U0 : lignes `oldStart`… (oldCount) remplacées par `newStart`… (newCount). */
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export function parseHunks(text: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const match of text.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    hunks.push({ oldStart: Number(match[1]), oldCount: Number(match[2] ?? 1), newStart: Number(match[3]), newCount: Number(match[4] ?? 1) });
  }
  return hunks;
}
