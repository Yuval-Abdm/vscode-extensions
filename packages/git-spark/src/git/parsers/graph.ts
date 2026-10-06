// Analyse de `git log --decorate=full --format=GRAPH_FORMAT` pour le graphe : commits, parents, références.

export interface GraphRef {
  name: string;
  /** head : HEAD détaché. */
  kind: 'head' | 'branch' | 'remote' | 'tag';
  /** Branche extraite (HEAD -> …). */
  current?: boolean;
}

export interface GraphCommit {
  sha: string;
  parents: string[];
  author: string;
  authorMail: string;
  authorTime: number;
  summary: string;
  refs: GraphRef[];
}

/** Huit champs séparés par NUL, chaque commit commence par NUL ; %D : références (avec --decorate=full). */
export const GRAPH_FORMAT = '%x00%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%D';

export function parseDecorations(text: string): GraphRef[] {
  const refs: GraphRef[] = [];
  for (const raw of text.split(', ')) {
    const item = raw.trim();
    if (!item) continue;
    if (item === 'HEAD') refs.push({ name: 'HEAD', kind: 'head' });
    else if (item.startsWith('HEAD -> refs/heads/')) refs.push({ name: item.slice('HEAD -> refs/heads/'.length), kind: 'branch', current: true });
    else if (item.startsWith('tag: refs/tags/')) refs.push({ name: item.slice('tag: refs/tags/'.length), kind: 'tag' });
    else if (item.startsWith('refs/heads/')) refs.push({ name: item.slice('refs/heads/'.length), kind: 'branch' });
    else if (item.startsWith('refs/remotes/') && !item.endsWith('/HEAD')) refs.push({ name: item.slice('refs/remotes/'.length), kind: 'remote' });
  }
  return refs;
}

export function parseGraphLog(text: string): GraphCommit[] {
  const commits: GraphCommit[] = [];
  const fields = text.split('\0');
  // Chaque enregistrement : NUL d'ouverture puis 7 champs ; le saut de ligne final appartient à %D (d'où trim()).
  for (let i = 1; i + 6 < fields.length; i += 7) {
    const [sha, parents, author, authorMail, authorTime, summary, decorations] = fields.slice(i, i + 7);
    commits.push({
      sha,
      parents: parents ? parents.split(' ') : [],
      author,
      authorMail,
      authorTime: Number(authorTime),
      summary,
      refs: parseDecorations(decorations.trim()),
    });
  }
  return commits;
}
