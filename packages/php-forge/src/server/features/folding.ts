// Plages de repli : blocs, déclarations, tableaux et listes d'arguments sur plusieurs lignes, commentaires,
// suites de `use`, régions (« // region … // endregion », « #region »).
import { FoldingRangeKind, type FoldingRange } from 'vscode-languageserver/node';
import type { Tree } from '../parser/parser.ts';

const BLOCKS = new Set(['compound_statement', 'declaration_list', 'enum_declaration_list', 'match_block', 'switch_block', 'array_creation_expression', 'arguments', 'formal_parameters']);
const STRINGS = new Set(['heredoc', 'nowdoc']);
const REGION = /^\s*(?:\/\/|#)\s*#?region\b/i;
const END_REGION = /^\s*(?:\/\/|#)\s*#?endregion\b/i;

export function foldingRanges(tree: Tree): FoldingRange[] {
  const out: FoldingRange[] = [];
  const add = (startLine: number, endLine: number, kind?: string) => {
    if (endLine > startLine) out.push(kind ? { startLine, endLine, kind } : { startLine, endLine });
  };
  const regions: number[] = [];
  let comments: { start: number; end: number } | undefined;
  let uses: { start: number; end: number } | undefined;
  const flushComments = () => {
    if (comments) add(comments.start, comments.end, FoldingRangeKind.Comment);
    comments = undefined;
  };

  const cursor = tree.walk();
  for (;;) {
    const node = cursor.currentNode;
    const start = node.startPosition.row;
    const end = node.endPosition.row;
    if (BLOCKS.has(node.type)) add(start, end - 1);
    else if (STRINGS.has(node.type)) add(start, end);
    else if (node.type === 'comment') {
      const text = node.text;
      if (REGION.test(text)) regions.push(start);
      else if (END_REGION.test(text)) {
        const open = regions.pop();
        if (open !== undefined) add(open, start, FoldingRangeKind.Region);
      } else if (text.startsWith('/*')) add(start, end, FoldingRangeKind.Comment);
      else if (comments && comments.end === start - 1) comments.end = start;
      else {
        flushComments();
        comments = { start, end: start };
      }
    } else if (node.type === 'namespace_use_declaration') {
      if (uses && uses.end >= start - 1) uses.end = end;
      else {
        if (uses) add(uses.start, uses.end, FoldingRangeKind.Imports);
        uses = { start, end };
      }
    }
    if (cursor.gotoFirstChild()) continue;
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent()) {
        cursor.delete();
        flushComments();
        if (uses) add(uses.start, uses.end, FoldingRangeKind.Imports);
        return out;
      }
    }
  }
}
