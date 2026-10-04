// Aller à l'implémentation : classes qui étendent ou implémentent une classe ou une interface ; méthodes qui
// implémentent ou redéfinissent une méthode.
import type { Location } from 'vscode-languageserver/node';
import type { FileSymbols, Position, SymbolKind } from '../../shared/types.ts';
import type { Lookup } from '../index/lookup.ts';
import type { IndexedSymbol } from '../index/symbolIndex.ts';
import type { Tree } from '../parser/parser.ts';
import { TypeResolver } from '../types/expand.ts';
import { nameAt } from './nameAt.ts';
import { ownerReceivers, resolveAt } from './resolve.ts';

const CLASS_LIKE = new Set<SymbolKind>(['class', 'interface', 'trait', 'enum']);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function implementations(lookup: Lookup, file: FileSymbols, tree: Tree, pos: Position, resolver = new TypeResolver(lookup)): Location[] {
  const ref = nameAt(tree, pos);
  if (ref?.kind === 'class') {
    const target = resolveAt(lookup, file, tree, pos, resolver)[0]?.symbol.fqn;
    return target ? subclasses(lookup, resolver, target).map((s) => ({ uri: s.uri, range: s.symbol.selectionRange })) : [];
  }
  if (ref?.kind === 'member' && ref.member === 'method') {
    const declaring = ownerReceivers(ref.owner, ref.node, file, resolver).flatMap((r) => resolver.findMember(r, ref.name, ['method']))[0];
    const owner = declaring?.owner.symbol.fqn;
    if (!owner) return [];
    const out: Location[] = [];
    for (const sub of subclasses(lookup, resolver, owner)) {
      for (const child of sub.symbol.children ?? []) {
        if (child.kind === 'method' && !child.virtual && same(child.name, ref.name)) out.push({ uri: sub.uri, range: child.selectionRange });
      }
    }
    return out;
  }
  return [];
}

/** Classes du workspace dont la hiérarchie contient `fqn`. */
function subclasses(lookup: Lookup, resolver: TypeResolver, fqn: string): IndexedSymbol[] {
  const out: IndexedSymbol[] = [];
  for (const file of lookup.workspace.files()) {
    for (const symbol of file.symbols) {
      if (!symbol.fqn || !CLASS_LIKE.has(symbol.kind) || same(symbol.fqn, fqn)) continue;
      for (const { hit } of resolver.hierarchy(symbol.fqn)) {
        if (hit.symbol.fqn && same(hit.symbol.fqn, fqn)) {
          out.push({ uri: file.uri, symbol });
          break;
        }
      }
    }
  }
  return out;
}
