// Erreurs de syntaxe : nœuds ERROR (le plus externe seulement, limité à sa première ligne) et MISSING.
import * as l10n from '@vscode/l10n';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import type { Range } from '../../shared/types.ts';
import { rangeOf } from '../model/ranges.ts';
import type { Node, Tree } from '../parser/parser.ts';

export function syntaxDiagnostics(tree: Tree, max = 100): Diagnostic[] {
  const out: Diagnostic[] = [];
  const visit = (node: Node): void => {
    if (out.length >= max) return;
    if (node.isMissing) {
      out.push(diagnostic(rangeOf(node), l10n.t('Syntax error: missing "{0}"', node.type)));
      return;
    }
    if (node.isError) {
      out.push(diagnostic(firstLine(node), l10n.t('Syntax error: unexpected "{0}"', firstToken(node))));
      return;
    }
    if (!node.hasError) return;
    for (const child of node.children) visit(child);
  };
  visit(tree.rootNode);
  return out;
}

function diagnostic(range: Range, message: string): Diagnostic {
  return { range, message, severity: DiagnosticSeverity.Error, source: 'PHP Forge', code: 'syntax-error' };
}

function firstLine(node: Node): Range {
  const range = rangeOf(node);
  if (range.start.line === range.end.line) return range;
  const length = node.text.split('\n')[0].length;
  return { start: range.start, end: { line: range.start.line, character: range.start.character + length } };
}

function firstToken(node: Node): string {
  let leaf = node;
  while (leaf.childCount > 0) leaf = leaf.child(0)!;
  return (leaf.text || node.text).trim().slice(0, 30);
}
