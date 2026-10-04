// Symboles désignés à une position : résolution des noms (namespace, use, self / parent) puis recherche.
import type { FileSymbols, NameScope, Position, SymbolKind } from '../../shared/types.ts';
import type { Lookup } from '../index/lookup.ts';
import type { IndexedSymbol } from '../index/symbolIndex.ts';
import { resolveClassName, resolveFunctionOrConstant, scopeAt } from '../model/names.ts';
import type { Node, Tree } from '../parser/parser.ts';
import { nameAt, type MemberKind, type Owner } from './nameAt.ts';

const MEMBER_KINDS: Record<MemberKind, SymbolKind[]> = {
  method: ['method'],
  property: ['property'],
  classConstant: ['classConstant', 'enumCase'],
};
const CLASS_DECLARATIONS = new Set(['class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration']);

export function resolveAt(lookup: Lookup, file: FileSymbols, tree: Tree, pos: Position): IndexedSymbol[] {
  const ref = nameAt(tree, pos);
  if (!ref) return [];
  const scope = scopeAt(file.scopes, pos);
  switch (ref.kind) {
    case 'class': {
      const fqn = classOf(ref.name, ref.node, scope, lookup);
      return fqn ? lookup.findClass(fqn) : [];
    }
    case 'function':
      return firstHit(resolveFunctionOrConstant(ref.name, 'function', scope), (n) => lookup.findFunction(n));
    case 'constant':
      return firstHit(resolveFunctionOrConstant(ref.name, 'constant', scope), (n) => lookup.findConstant(n));
    case 'member': {
      const owner = ownerOf(ref.owner, ref.node, scope, lookup);
      const kinds = MEMBER_KINDS[ref.member];
      return owner ? lookup.findMembers(owner, ref.name, kinds) : lookup.findMembersAnywhere(ref.name, kinds);
    }
  }
}

function firstHit(candidates: string[], find: (name: string) => IndexedSymbol[]): IndexedSymbol[] {
  for (const candidate of candidates) {
    const hits = find(candidate);
    if (hits.length) return hits;
  }
  return [];
}

/** Nom complet d'une classe écrite `name`, y compris self / static / parent. */
function classOf(name: string, node: Node, scope: NameScope, lookup: Lookup): string | undefined {
  const lower = name.toLowerCase();
  if (lower === 'self' || lower === 'static') return enclosingClass(node, scope);
  if (lower === 'parent') return parentOf(enclosingClass(node, scope), lookup);
  return resolveClassName(name, scope);
}

function ownerOf(owner: Owner, node: Node, scope: NameScope, lookup: Lookup): string | undefined {
  switch (owner.kind) {
    case 'class':
      return classOf(owner.name, node, scope, lookup);
    case 'self':
      return enclosingClass(node, scope);
    case 'parent':
      return parentOf(enclosingClass(node, scope), lookup);
    case 'unknown':
      return undefined;
  }
}

function enclosingClass(node: Node, scope: NameScope): string | undefined {
  for (let n = node.parent; n; n = n.parent) {
    if (!CLASS_DECLARATIONS.has(n.type)) continue;
    const name = n.childForFieldName('name')?.text;
    return name && (scope.namespace ? `${scope.namespace}\\${name}` : name);
  }
  return undefined;
}

function parentOf(fqn: string | undefined, lookup: Lookup): string | undefined {
  return fqn ? lookup.findClass(fqn)[0]?.symbol.extends?.[0] : undefined;
}
