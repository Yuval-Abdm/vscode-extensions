// Évaluation symbolique des chemins d'include (§4.1) : littéraux, concaténation, interpolation simple, __DIR__,
// __FILE__, dirname(x[, n]), realpath(x), $_SERVER['DOCUMENT_ROOT'], constantes, variables locales affectées une
// seule fois avant l'include. Le reste est inconnu ; dans une concaténation, il est gardé à sa place pour que le
// préfixe connu (« ROOT_PATH.'/templates/' ») reste exploitable.
import type { PathExpr } from '../../shared/types.ts';
import type { Node } from '../parser/parser.ts';

export const UNKNOWN_PATH: PathExpr = { k: 'unknown' };

/** Valeur d'une variable locale affectée une seule fois avant la position `before` (nœud de la valeur). */
export type LocalValue = (name: string, before: number) => Node | undefined;

const MAX_DEPTH = 8;
const STATEMENT_CONTAINERS = new Set(['program', 'compound_statement', 'colon_block', 'case_statement', 'default_statement']);

export function pathExprOf(node: Node | null | undefined, local: LocalValue = () => undefined, depth = 0): PathExpr {
  if (!node || depth > MAX_DEPTH) return UNKNOWN_PATH;
  const next = (child: Node | null | undefined) => pathExprOf(child, local, depth + 1);
  switch (node.type) {
    case 'parenthesized_expression':
      return next(node.namedChildren[0]);
    case 'string':
      return { k: 'lit', v: node.text.slice(1, -1).replace(/\\(['\\])/g, '$1') };
    case 'encapsed_string':
      return cat(node.namedChildren.map((part): PathExpr => {
        if (part.type === 'string_content') return { k: 'lit', v: part.text };
        if (part.type === 'escape_sequence') return { k: 'lit', v: unescape(part.text) };
        return next(part);
      }));
    case 'binary_expression':
      if (node.childForFieldName('operator')?.type !== '.') return UNKNOWN_PATH;
      return cat([next(node.childForFieldName('left')), next(node.childForFieldName('right'))]);
    case 'name':
    case 'qualified_name': {
      const name = node.text.replace(/^\\/, '');
      if (name === '__DIR__') return { k: 'dir' };
      if (name === '__FILE__') return { k: 'file' };
      return { k: 'const', name };
    }
    case 'subscript_expression': {
      const [base, key] = node.namedChildren;
      return base?.text === '$_SERVER' && key && /^(['"])DOCUMENT_ROOT\1$/.test(key.text) ? { k: 'docroot' } : UNKNOWN_PATH;
    }
    case 'function_call_expression': {
      const fn = node.childForFieldName('function')?.text.replace(/^\\/, '').toLowerCase();
      const args = (node.childForFieldName('arguments')?.namedChildren ?? [])
        .filter((a) => a.type === 'argument')
        .map((a) => a.namedChildren[a.namedChildren.length - 1]);
      if (fn === 'realpath' && args[0]) return next(args[0]);
      if (fn === 'dirname' && args[0]) {
        const of = next(args[0]);
        const levels = args[1]?.type === 'integer' ? Number(args[1].text) : 1;
        return of.k === 'unknown' || !(levels >= 1) ? UNKNOWN_PATH : { k: 'dirname', of, levels };
      }
      return UNKNOWN_PATH;
    }
    case 'variable_name': {
      const value = local(node.text.slice(1), node.startIndex);
      return value ? next(value) : UNKNOWN_PATH;
    }
    default:
      return UNKNOWN_PATH;
  }
}

/** Concaténation aplatie, littéraux voisins fusionnés ; entièrement inconnue si aucune partie n'est connue. */
function cat(parts: PathExpr[]): PathExpr {
  const out: PathExpr[] = [];
  for (const part of parts.flatMap((p) => (p.k === 'cat' ? p.parts : [p]))) {
    const last = out[out.length - 1];
    if (part.k === 'lit' && last?.k === 'lit') out[out.length - 1] = { k: 'lit', v: last.v + part.v };
    else if (part.k === 'unknown' && last?.k === 'unknown') continue;
    else out.push(part);
  }
  if (out.length === 0) return { k: 'lit', v: '' };
  if (out.every((p) => p.k === 'unknown')) return UNKNOWN_PATH;
  return out.length === 1 ? out[0] : { k: 'cat', parts: out };
}

function unescape(sequence: string): string {
  const map: Record<string, string> = { '\\n': '\n', '\\t': '\t', '\\\\': '\\', '\\"': '"', '\\$': '$' };
  return map[sequence] ?? sequence;
}

/** Chemin donné par `/** @include chemin *\/` ou `// @include chemin` sur la ligne qui précède l'instruction. */
export function includeHint(include: Node): string | undefined {
  let statement: Node = include;
  while (statement.parent && !STATEMENT_CONTAINERS.has(statement.parent.type)) statement = statement.parent;
  const previous = statement.previousNamedSibling;
  if (previous?.type !== 'comment' || previous.endPosition.row < statement.startPosition.row - 1) return undefined;
  return /@include\s+(['"]?)([^\s'"*]+)\1/.exec(previous.text)?.[2];
}
