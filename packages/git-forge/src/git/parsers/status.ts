// Analyse de `git status --porcelain=v2 --branch -z` : branche courante, fichiers en conflit, nombre de modifications.

export type ConflictKind =
  | 'both-modified'
  | 'both-added'
  | 'both-deleted'
  | 'added-by-us'
  | 'added-by-them'
  | 'deleted-by-us'
  | 'deleted-by-them';

export interface ConflictFile {
  path: string;
  kind: ConflictKind;
}

export interface BranchStatus {
  /** Branche courante ; undefined si HEAD est détaché. */
  head?: string;
  upstream?: string;
  ahead: number;
  behind: number;
}

export interface Status {
  branch: BranchStatus;
  conflicts: ConflictFile[];
  /** Fichiers suivis modifiés (index ou arbre de travail), hors conflits. */
  changes: number;
}

const KINDS: Record<string, ConflictKind> = {
  UU: 'both-modified',
  AA: 'both-added',
  DD: 'both-deleted',
  AU: 'added-by-us',
  UA: 'added-by-them',
  DU: 'deleted-by-us',
  UD: 'deleted-by-them',
};

export function parseStatusV2(text: string): Status {
  const status: Status = { branch: { ahead: 0, behind: 0 }, conflicts: [], changes: 0 };
  const records = text.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.startsWith('# branch.head ')) {
      const head = record.slice('# branch.head '.length);
      if (head !== '(detached)') status.branch.head = head;
    } else if (record.startsWith('# branch.upstream ')) {
      status.branch.upstream = record.slice('# branch.upstream '.length);
    } else if (record.startsWith('# branch.ab ')) {
      const match = /^\+(\d+) -(\d+)$/.exec(record.slice('# branch.ab '.length));
      if (match) {
        status.branch.ahead = Number(match[1]);
        status.branch.behind = Number(match[2]);
      }
    } else if (record.startsWith('u ')) {
      const fields = record.split(' ');
      status.conflicts.push({ path: fields.slice(10).join(' '), kind: KINDS[fields[1]] ?? 'both-modified' });
    } else if (record.startsWith('1 ')) {
      status.changes++;
    } else if (record.startsWith('2 ')) {
      status.changes++;
      i++; // renommage ou copie : l'ancien chemin est l'enregistrement suivant
    }
  }
  return status;
}
