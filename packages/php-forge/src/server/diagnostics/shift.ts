// Diagnostics calculés sur une version précédente du document (analyse des inclusions) : déplacés au fil des
// modifications jusqu'à la prochaine analyse ; ceux que la modification touche disparaissent.
import type { Diagnostic } from 'vscode-languageserver/node';
import type { Position } from '../../shared/types.ts';
import type { TextChange } from '../documents.ts';

const before = (a: Position, b: Position) => a.line < b.line || (a.line === b.line && a.character <= b.character);

export function shiftDiagnostics(diagnostics: Diagnostic[], changes: TextChange[]): Diagnostic[] {
  let out = diagnostics;
  for (const change of changes) {
    if (!change.range) return [];
    const { start, end } = change.range;
    const lines = change.text.split('\n');
    const lineDelta = lines.length - 1 - (end.line - start.line);
    // Nouvelle colonne de la fin de la modification
    const newEnd = lines.length === 1 ? start.character + change.text.length : lines[lines.length - 1].length;
    const move = (p: Position): Position => (p.line === end.line ? { line: p.line + lineDelta, character: p.character - end.character + newEnd } : { line: p.line + lineDelta, character: p.character });
    out = out.flatMap((d) => {
      if (before(d.range.end, start)) return [d];
      if (!before(end, d.range.start)) return [];
      return [{ ...d, range: { start: move(d.range.start), end: move(d.range.end) } }];
    });
  }
  return out;
}
