// Sélection intelligente : du nœud sous le curseur vers ses ancêtres, sans plage répétée.
import type { SelectionRange } from 'vscode-languageserver/node';
import type { Position, Range } from '../../shared/types.ts';
import { rangeOf } from '../model/ranges.ts';
import type { Node, Tree } from '../parser/parser.ts';

const sameRange = (a: Range, b: Range) =>
  a.start.line === b.start.line && a.start.character === b.start.character && a.end.line === b.end.line && a.end.character === b.end.character;

export function selectionRanges(tree: Tree, positions: Position[]): SelectionRange[] {
  return positions.map((pos) => {
    const ranges: Range[] = [];
    for (let node: Node | null = tree.rootNode.descendantForPosition({ row: pos.line, column: pos.character }); node; node = node.parent) {
      const range = rangeOf(node);
      if (!ranges.length || !sameRange(ranges[ranges.length - 1], range)) ranges.push(range);
    }
    let result: SelectionRange | undefined;
    for (let i = ranges.length - 1; i >= 0; i--) result = result ? { range: ranges[i], parent: result } : { range: ranges[i] };
    return result ?? { range: { start: pos, end: pos } };
  });
}
