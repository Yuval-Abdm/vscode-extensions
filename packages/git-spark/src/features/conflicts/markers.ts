// Blocs de conflit d'un fichier (marqueurs <<<<<<< / ||||||| / ======= / >>>>>>>) et lignes qui les résolvent.
// Sans dépendance à VS Code.

export interface ConflictBlock {
  /** Ligne du marqueur <<<<<<< (0-based). */
  start: number;
  /** Ligne du marqueur =======. */
  separator: number;
  /** Ligne du marqueur ||||||| (style diff3), s'il y en a un. */
  base: number | undefined;
  /** Ligne du marqueur >>>>>>>. */
  end: number;
  oursLabel: string;
  theirsLabel: string;
}

export type Choice = 'ours' | 'theirs' | 'both';

/** Marqueur d'au moins 7 caractères (conflict-marker-size), seul ou suivi d'une espace et d'un libellé. */
function marker(line: string, char: string): string | undefined {
  let size = 0;
  while (line[size] === char) size++;
  if (size < 7) return undefined;
  if (size === line.length) return '';
  return line[size] === ' ' ? line.slice(size + 1) : undefined;
}

export function findConflicts(lines: readonly string[]): ConflictBlock[] {
  const blocks: ConflictBlock[] = [];
  let open: { start: number; oursLabel: string; base?: number; separator?: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    const ours = marker(line, '<');
    if (ours !== undefined) {
      open = { start: i, oursLabel: ours };
      continue;
    }
    if (!open) continue;
    if (open.separator === undefined) {
      if (marker(line, '|') !== undefined) open.base = i;
      else if (/^={7,}$/.test(line)) open.separator = i;
      continue;
    }
    const theirs = marker(line, '>');
    if (theirs !== undefined) {
      blocks.push({ start: open.start, separator: open.separator, base: open.base, end: i, oursLabel: open.oursLabel, theirsLabel: theirs });
      open = undefined;
    }
  }
  return blocks;
}

/** Lignes qui remplacent le bloc entier (marqueurs compris). La base diff3 n'est jamais gardée. */
export function resolveBlock(lines: readonly string[], block: ConflictBlock, choice: Choice): string[] {
  const ours = lines.slice(block.start + 1, block.base ?? block.separator);
  const theirs = lines.slice(block.separator + 1, block.end);
  if (choice === 'ours') return ours;
  if (choice === 'theirs') return theirs;
  return [...ours, ...theirs];
}

/** Marqueur de début ou de fin restant, même sans bloc complet. */
export function hasConflictMarkers(text: string): boolean {
  return /^(<{7,}|>{7,})( |\r?$)/m.test(text);
}
