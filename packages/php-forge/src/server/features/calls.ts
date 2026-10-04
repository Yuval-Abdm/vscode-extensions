// Appels : appel le plus proche autour d'une position, argument actif, et déclaration appelée
// (fonction, méthode, méthode statique, constructeur).
import type { FileSymbols, PhpSymbol, TypeExpr } from '../../shared/types.ts';
import { resolveFunctionOrConstant, scopeAt } from '../model/names.ts';
import { rangeOf } from '../model/ranges.ts';
import type { Node, Tree } from '../parser/parser.ts';
import { bindingAt, type Binding, type TypeResolver } from '../types/expand.ts';
import type { Inferrer } from '../types/infer.ts';
import { members } from '../types/type.ts';

export const CALLS = new Set(['function_call_expression', 'member_call_expression', 'nullsafe_member_call_expression', 'scoped_call_expression', 'object_creation_expression']);
const NAMES = new Set(['name', 'qualified_name', 'relative_name']);

export interface CallSite {
  call: Node;
  args: Node;
  /** Index de l'argument où se trouve la position (virgules qui précèdent) */
  active: number;
  /** Nom de l'argument nommé en cours, s'il y en a un */
  named?: string;
}

export interface CallTarget {
  symbol: PhpSymbol;
  binding: Binding;
  /** Classe du constructeur appelé par `new` */
  owner?: string;
}

/** Appel dont la liste d'arguments contient la position (le plus imbriqué). */
export function callAt(tree: Tree, offset: number): CallSite | undefined {
  for (let node: Node | null = tree.rootNode.descendantForIndex(offset); node; node = node.parent) {
    if (!CALLS.has(node.type)) continue;
    const args = node.childForFieldName('arguments') ?? node.namedChildren.find((c) => c.type === 'arguments');
    if (!args || offset <= args.startIndex) continue;
    const closing = args.lastChild;
    const closed = closing?.type === ')' && !closing.isMissing;
    if (closed && offset >= args.endIndex) continue;
    let active = 0;
    for (const child of args.children) {
      if (child.startIndex >= offset) break;
      if (!child.isNamed && child.type === ',') active++;
    }
    const current = args.namedChildren.find((a) => a.type === 'argument' && a.startIndex <= offset && offset <= a.endIndex);
    // « nom: » sans valeur encore : tree-sitter le coupe en argument + ERROR, on lit le texte de l'argument
    const typed = args.text.slice(0, offset - args.startIndex).split(',').pop() ?? '';
    const named = current?.childForFieldName('name')?.text ?? /^\s*\(?\s*([A-Za-z_]\w*)\s*:(?!:)/.exec(typed)?.[1];
    return named ? { call: node, args, active, named } : { call: node, args, active };
  }
  return undefined;
}

export function callTarget(call: Node, file: FileSymbols, resolver: TypeResolver, inferrer: Inferrer): CallTarget | undefined {
  const binding = bindingAt(call, file.scopes);
  const method = (receiverType: TypeExpr, name: string | undefined, owner?: boolean): CallTarget | undefined => {
    if (!name) return undefined;
    for (const receiver of members(resolver.expand(receiverType, binding))) {
      if (receiver.kind !== 'class') continue;
      const hit = resolver.findMember(receiver, name, ['method'])[0];
      if (hit) return owner ? { symbol: hit.member, binding: hit.binding, owner: receiver.fqn } : { symbol: hit.member, binding: hit.binding };
    }
    return undefined;
  };
  switch (call.type) {
    case 'function_call_expression': {
      const fn = call.childForFieldName('function');
      if (!fn || !NAMES.has(fn.type)) return undefined;
      for (const name of resolveFunctionOrConstant(fn.text, 'function', scopeAt(file.scopes, rangeOf(fn).start))) {
        const hit = resolver.pick(resolver.lookup.findFunction(name));
        if (hit) return { symbol: hit.symbol, binding: {} };
      }
      return undefined;
    }
    case 'member_call_expression':
    case 'nullsafe_member_call_expression':
      return method(inferrer.expr(call.childForFieldName('object')), call.childForFieldName('name')?.text);
    case 'scoped_call_expression':
      return method(inferrer.classOf(call.childForFieldName('scope')), call.childForFieldName('name')?.text);
    case 'object_creation_expression':
      return method(inferrer.classOf(call.namedChildren[0]), '__construct', true);
    default:
      return undefined;
  }
}
