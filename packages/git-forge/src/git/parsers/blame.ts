// Analyse de `git blame --incremental` : pour chaque ligne du fichier, le commit qui l'a écrite.

export interface BlameCommit {
  sha: string;
  author: string;
  authorMail: string;
  /** Date de l'auteur, en secondes depuis l'époque Unix. */
  authorTime: number;
  /** Première ligne du message. */
  summary: string;
  /** Chemin du fichier dans ce commit (diffère du chemin actuel après un renommage). */
  filename: string;
  /** Parent et chemin du fichier dans ce parent ; absent pour un commit racine. */
  previous?: { sha: string; filename: string };
}

export interface BlameResult {
  commits: Map<string, BlameCommit>;
  /** SHA du commit de chaque ligne (indice 0 = ligne 1). */
  lines: string[];
}

/** Les lignes non commitées sont attribuées au SHA 000…0. */
export function isUncommitted(sha: string): boolean {
  return /^0+$/.test(sha);
}

const HEADER = /^([0-9a-f]{40,64}) (\d+) (\d+) (\d+)$/;

export function parseBlameIncremental(text: string): BlameResult {
  const commits = new Map<string, BlameCommit>();
  const lines: string[] = [];
  let current: BlameCommit | undefined;
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    const header = HEADER.exec(raw);
    if (header) {
      const sha = header[1];
      const finalLine = Number(header[3]);
      const count = Number(header[4]);
      for (let i = 0; i < count; i++) lines[finalLine - 1 + i] = sha;
      current = commits.get(sha);
      if (!current) {
        current = { sha, author: '', authorMail: '', authorTime: 0, summary: '', filename: '' };
        commits.set(sha, current);
      }
      continue;
    }
    if (!current) continue;
    const space = raw.indexOf(' ');
    const key = space < 0 ? raw : raw.slice(0, space);
    const value = space < 0 ? '' : raw.slice(space + 1);
    switch (key) {
      case 'author':
        current.author = value;
        break;
      case 'author-mail':
        current.authorMail = value.replace(/^<|>$/g, '');
        break;
      case 'author-time':
        current.authorTime = Number(value);
        break;
      case 'summary':
        current.summary = value;
        break;
      case 'previous': {
        const separator = value.indexOf(' ');
        current.previous ??= { sha: value.slice(0, separator), filename: value.slice(separator + 1) };
        break;
      }
      case 'filename':
        if (!current.filename) current.filename = value;
        break;
    }
  }
  return { commits, lines };
}
