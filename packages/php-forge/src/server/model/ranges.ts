// Positions tree-sitter → LSP (mêmes unités UTF-16) et tests d'inclusion.
import type { Position, Range } from '../../shared/types.ts';
import type { Node } from '../parser/parser.ts';

export function rangeOf(node: Node): Range {
  const start = node.startPosition;
  const end = node.endPosition;
  return { start: { line: start.row, character: start.column }, end: { line: end.row, character: end.column } };
}

/** a ≤ b */
export function before(a: Position, b: Position): boolean {
  return a.line < b.line || (a.line === b.line && a.character <= b.character);
}

export function contains(range: Range, pos: Position): boolean {
  return before(range.start, pos) && before(pos, range.end);
}
