// Symboles désignés à une position : résolution des noms (namespace, use, self / parent), type de l'objet
// (inférence) puis recherche dans l'index ; pour un membre redéfini, la déclaration la plus proche.
import type { FileSymbols, Position, SymbolKind } from '../../shared/types.ts';
import type { Lookup } from '../index/lookup.ts';
import type { IndexedSymbol } from '../index/symbolIndex.ts';
import { enclosingClass } from '../model/context.ts';
import { resolveClassName, resolveFunctionOrConstant, scopeAt } from '../model/names.ts';
import { rangeOf } from '../model/ranges.ts';
import type { Node, Tree } from '../parser/parser.ts';
import { bindingAt, TypeResolver, type Receiver } from '../types/expand.ts';
import { Inferrer } from '../types/infer.ts';
import { members } from '../types/type.ts';
import { nameAt, type MemberKind, type Owner } from './nameAt.ts';

const MEMBER_KINDS: Record<MemberKind, SymbolKind[]> = {
  method: ['method'],
  property: ['property'],
  classConstant: ['classConstant', 'enumCase'],
};

export function resolveAt(lookup: Lookup, file: FileSymbols, tree: Tree, pos: Position, resolver = new TypeResolver(lookup)): IndexedSymbol[] {
  const ref = nameAt(tree, pos);
  if (!ref) return [];
  const scope = scopeAt(file.scopes, pos);
  switch (ref.kind) {
    case 'class': {
      const fqn = classOf(ref.name, ref.node, file, resolver);
      return fqn ? lookup.findClass(fqn) : [];
    }
    case 'function':
      return firstHit(resolveFunctionOrConstant(ref.name, 'function', scope), (n) => lookup.findFunction(n));
    case 'constant':
      return firstHit(resolveFunctionOrConstant(ref.name, 'constant', scope), (n) => lookup.findConstant(n));
    case 'member': {
      const kinds = MEMBER_KINDS[ref.member];
      const receivers = ownerReceivers(ref.owner, ref.node, file, resolver);
      const hits: IndexedSymbol[] = [];
      const seen = new Set<string>();
      for (const receiver of receivers) {
        for (const hit of resolver.findMember(receiver, ref.name, kinds)) {
          const key = `${hit.owner.uri}#${hit.member.selectionRange.start.line}:${hit.member.selectionRange.start.character}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push({ uri: hit.owner.uri, symbol: hit.member });
        }
      }
      // Type de l'objet inconnu : toutes les déclarations de ce nom (code historique sans types)
      return receivers.length ? hits : lookup.findMembersAnywhere(ref.name, kinds);
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
function classOf(name: string, node: Node, file: FileSymbols, resolver: TypeResolver): string | undefined {
  const lower = name.toLowerCase();
  const self = enclosingClass(node, file.scopes);
  if (lower === 'self' || lower === 'static') return self;
  if (lower === 'parent') return self && resolver.parentOf(self);
  return resolveClassName(name, scopeAt(file.scopes, rangeOf(node).start));
}

/** Classes possibles du propriétaire d'un membre ; vide si son type est inconnu. */
export function ownerReceivers(owner: Owner, node: Node, file: FileSymbols, resolver: TypeResolver): Receiver[] {
  const self = enclosingClass(node, file.scopes);
  let fqn: string | undefined;
  switch (owner.kind) {
    case 'class':
      fqn = classOf(owner.name, node, file, resolver);
      break;
    case 'self':
      fqn = self;
      break;
    case 'parent':
      fqn = self && resolver.parentOf(self);
      break;
    case 'expression': {
      const type = resolver.expand(new Inferrer(file.scopes).expr(owner.node), bindingAt(node, file.scopes));
      return members(type).flatMap((t) => (t.kind === 'class' ? [t.args ? { fqn: t.fqn, args: t.args } : { fqn: t.fqn }] : []));
    }
    case 'unknown':
      return [];
  }
  return fqn ? [{ fqn }] : [];
}
