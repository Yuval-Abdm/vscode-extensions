// Occurrences du symbole sous le curseur : la même variable dans sa portée, ou la même classe, fonction,
// constante ou le même membre dans le document. Les candidats sont trouvés dans le texte puis vérifiés
// par l'arbre (pas de parcours de tous les nœuds).
import { DocumentHighlightKind, type DocumentHighlight } from 'vscode-languageserver/node';
import type { Position } from '../../shared/types.ts';
import { CLASS_DECLARATIONS } from '../model/context.ts';
import type { Node, Tree } from '../parser/parser.ts';
import { scopeRoot } from '../types/flow.ts';
import { nameAt, variableAt, type Reference } from './nameAt.ts';

const WRITE_PARENTS = new Set(['simple_parameter', 'variadic_parameter', 'property_promotion_parameter', 'catch_clause', 'static_variable_declaration', 'global_declaration', 'list_literal', 'pair', 'by_ref']);
const DECLARATIONS = new Set([...CLASS_DECLARATIONS, 'function_definition', 'method_declaration', 'enum_case']);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Conversion index → position avec une table des débuts de ligne. */
function positions(text: string): (index: number) => Position {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: index - starts[lo] };
  };
}

export function highlights(tree: Tree, text: string, pos: Position): DocumentHighlight[] {
  const at = positions(text);
  const variable = variableAt(tree, pos);
  if (variable) return variableHighlights(tree, text, variable, at);
  const ref = nameAt(tree, pos);
  if (!ref) return [];
  const short = shortName(ref);
  if (!short) return [];
  const caseless = ref.kind === 'class' || ref.kind === 'function' || (ref.kind === 'member' && ref.member === 'method');
  const pattern = new RegExp(`(?<![\\w\\\\])${escape(short)}(?!\\w)`, caseless ? 'gi' : 'g');
  const out: DocumentHighlight[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = at(match.index);
    const other = nameAt(tree, start);
    if (!other || !sameTarget(ref, other)) continue;
    out.push({
      range: { start, end: { line: start.line, character: start.character + short.length } },
      kind: isDeclaration(other.node) ? DocumentHighlightKind.Write : DocumentHighlightKind.Text,
    });
  }
  return out;
}

function variableHighlights(tree: Tree, text: string, variable: Node, at: (index: number) => Position): DocumentHighlight[] {
  const root = scopeRoot(variable);
  const name = variable.text;
  const out: DocumentHighlight[] = [];
  for (const match of text.slice(root.startIndex, root.endIndex).matchAll(new RegExp(`${escape(name)}(?!\\w)`, 'g'))) {
    const index = root.startIndex + match.index;
    const position = at(index);
    const node = variableAt(tree, position);
    if (!node || node.startIndex !== index || scopeRoot(node).id !== root.id) continue;
    out.push({ range: { start: position, end: at(index + name.length) }, kind: isWrite(node) ? DocumentHighlightKind.Write : DocumentHighlightKind.Read });
  }
  return out;
}

function shortName(ref: Reference): string {
  const name = ref.name.replace(/^\\/, '');
  return name.slice(name.lastIndexOf('\\') + 1);
}

function sameTarget(a: Reference, b: Reference): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'member' && (b.kind !== 'member' || a.member !== b.member)) return false;
  const caseless = a.kind === 'class' || a.kind === 'function' || (a.kind === 'member' && a.member === 'method');
  const x = shortName(a);
  const y = shortName(b);
  return caseless ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function isDeclaration(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === 'const_element') return parent.namedChildren[0]?.id === node.id;
  return DECLARATIONS.has(parent.type) && parent.childForFieldName('name')?.id === node.id;
}

function isWrite(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (['assignment_expression', 'augmented_assignment_expression', 'reference_assignment_expression'].includes(parent.type)) {
    return parent.childForFieldName('left')?.id === node.id;
  }
  if (parent.type === 'foreach_statement') return parent.namedChildren[0]?.id !== node.id;
  return WRITE_PARENTS.has(parent.type);
}
