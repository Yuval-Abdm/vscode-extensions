// Mise en forme du blame, sans dépendance à VS Code.
import type { BlameResult } from '../../git/parsers/blame.ts';

export const DEFAULT_FORMAT = '${author}, ${date} • ${message}';

export interface BlameFormatValues {
  author: string;
  date: string;
  message: string;
  sha: string;
}

/** Remplace ${author}, ${date}, ${message} et ${sha} (7 caractères) ; les autres ${…} restent tels quels. */
export function formatBlame(template: string, values: BlameFormatValues): string {
  return template.replace(/\$\{(author|date|message|sha)\}/g, (_, key: keyof BlameFormatValues) =>
    key === 'sha' ? values.sha.slice(0, 7) : values[key],
  );
}

export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

const DAY = 86400;

/** Tranche d'âge d'un commit : 0 (moins d'une semaine), 1 (d'un mois), 2 (de six mois), 3 (d'un an), 4 (plus). */
export function ageBucket(authorTime: number, nowSeconds: number): number {
  const age = nowSeconds - authorTime;
  if (age < 7 * DAY) return 0;
  if (age < 30 * DAY) return 1;
  if (age < 182 * DAY) return 2;
  if (age < 365 * DAY) return 3;
  return 4;
}

/** Suite de lignes consécutives écrites par le même commit (indices 0-based, `end` inclus). */
export interface BlameBlock {
  start: number;
  end: number;
  sha: string;
}

export function blameBlocks(result: BlameResult): BlameBlock[] {
  const blocks: BlameBlock[] = [];
  result.lines.forEach((sha, line) => {
    const last = blocks.at(-1);
    if (last && last.sha === sha && last.end === line - 1) last.end = line;
    else blocks.push({ start: line, end: line, sha });
  });
  return blocks;
}
