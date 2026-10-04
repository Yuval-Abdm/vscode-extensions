// Indications inline : nom du paramètre devant une valeur littérale (comme PhpStorm), et en option le type
// des variables affectées et le type de retour déduit des fonctions sans type déclaré.
import { InlayHintKind, type InlayHint } from 'vscode-languageserver/node';
import type { FileSymbols, Range, TypeExpr } from '../../shared/types.ts';
import type { InlayHintSettings } from '../../shared/protocol.ts';
import type { Node, Tree } from '../parser/parser.ts';
import { bindingAt, type TypeResolver } from '../types/expand.ts';
import { Inferrer } from '../types/infer.ts';
import { formatType } from '../types/type.ts';
import { CALLS, callTarget } from './calls.ts';

const LITERALS = new Set(['integer', 'float', 'string', 'encapsed_string', 'boolean', 'null', 'array_creation_expression', 'heredoc', 'nowdoc', 'name', 'qualified_name', 'class_constant_access_expression']);
const OBVIOUS = new Set(['integer', 'float', 'string', 'encapsed_string', 'boolean', 'null', 'heredoc', 'nowdoc', 'object_creation_expression', 'cast_expression']);

function isLiteral(node: Node): boolean {
  if (LITERALS.has(node.type)) return true;
  return node.type === 'unary_op_expression' && ['integer', 'float'].includes(node.namedChildren[0]?.type ?? '');
}

const positionOf = (node: Node, end = false) => {
  const point = end ? node.endPosition : node.startPosition;
  return { line: point.row, character: point.column };
};

export function inlayHints(resolver: TypeResolver, file: FileSymbols, tree: Tree, range: Range, options: InlayHintSettings): InlayHint[] {
  const out: InlayHint[] = [];
  const inferrer = new Inferrer(file.scopes);
  const start = { row: range.start.line, column: range.start.character };
  const end = { row: range.end.line, column: range.end.character };
  const nodes = (types: string[]) => tree.rootNode.descendantsOfType(types, start, end).filter((n): n is Node => !!n);
  const show = (node: Node, type: TypeExpr) => formatType(resolver.expand(type, bindingAt(node, file.scopes)));

  if (options.parameterNames) {
    for (const call of nodes([...CALLS])) {
      const target = callTarget(call, file, resolver, inferrer);
      const params = target?.symbol.params ?? [];
      if (!params.length) continue;
      const args = (call.childForFieldName('arguments') ?? call.namedChildren.find((c) => c.type === 'arguments'))?.namedChildren.filter((a) => a.type === 'argument') ?? [];
      args.forEach((arg, i) => {
        if (arg.childForFieldName('name')) return;
        const value = arg.namedChildren[arg.namedChildren.length - 1];
        const param = params[i] ?? (params[params.length - 1]?.variadic ? params[params.length - 1] : undefined);
        if (!value || !param || value.type === 'variadic_unpacking' || !isLiteral(value)) return;
        if (param.variadic && i > params.indexOf(param)) return;
        out.push({ position: positionOf(arg), label: `${param.name}:`, kind: InlayHintKind.Parameter, paddingRight: true });
      });
    }
  }

  if (options.variableTypes) {
    for (const assignment of nodes(['assignment_expression'])) {
      const left = assignment.childForFieldName('left');
      const right = assignment.childForFieldName('right');
      if (left?.type !== 'variable_name' || !right || OBVIOUS.has(right.type)) continue;
      const type = show(assignment, inferrer.expr(right));
      if (type !== 'mixed') out.push({ position: positionOf(left, true), label: `: ${type}`, kind: InlayHintKind.Type });
    }
  }

  if (options.returnTypes) {
    for (const fn of nodes(['function_definition', 'method_declaration', 'anonymous_function'])) {
      if (fn.childForFieldName('return_type')) continue;
      const anchor = fn.namedChildren.find((c) => c.type === 'anonymous_function_use_clause') ?? fn.childForFieldName('parameters');
      const returns = inferrer.inferReturn(fn);
      if (!anchor || !returns) continue;
      const type = show(fn, returns);
      if (type !== 'mixed') out.push({ position: positionOf(anchor, true), label: `: ${type}`, kind: InlayHintKind.Type });
    }
  }

  return out.sort((a, b) => a.position.line - b.position.line || a.position.character - b.position.character);
}
