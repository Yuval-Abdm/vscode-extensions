// Recherche combinée (workspace puis fonctions natives) et parcours de la hiérarchie des classes.
import type { SymbolKind } from '../../shared/types.ts';
import type { IndexedSymbol, SymbolIndex } from './symbolIndex.ts';

const sameMember = (kind: SymbolKind, a: string, b: string) => (kind === 'method' ? a.toLowerCase() === b.toLowerCase() : a === b);

export class Lookup {
  readonly workspace: SymbolIndex;
  stubs: SymbolIndex;

  constructor(workspace: SymbolIndex, stubs: SymbolIndex) {
    this.workspace = workspace;
    this.stubs = stubs;
  }

  findClass(fqn: string): IndexedSymbol[] {
    return [...this.workspace.findClass(fqn), ...this.stubs.findClass(fqn)];
  }

  findFunction(fqn: string): IndexedSymbol[] {
    return [...this.workspace.findFunction(fqn), ...this.stubs.findFunction(fqn)];
  }

  findConstant(fqn: string): IndexedSymbol[] {
    return [...this.workspace.findConstant(fqn), ...this.stubs.findConstant(fqn)];
  }

  /** La classe puis ses ancêtres (parents, traits, interfaces), en largeur, sans doublon ni boucle. */
  *ancestors(fqn: string): Generator<IndexedSymbol> {
    const seen = new Set<string>();
    const queue = [fqn];
    while (queue.length) {
      const name = queue.shift()!;
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      for (const hit of this.findClass(name)) {
        yield hit;
        queue.push(...(hit.symbol.extends ?? []), ...(hit.symbol.uses ?? []), ...(hit.symbol.implements ?? []));
      }
    }
  }

  /** Membres `name` de la classe ou de ses ancêtres. */
  findMembers(classFqn: string, name: string, kinds: SymbolKind[]): IndexedSymbol[] {
    const out: IndexedSymbol[] = [];
    for (const owner of this.ancestors(classFqn)) {
      for (const child of owner.symbol.children ?? []) {
        if (kinds.includes(child.kind) && sameMember(child.kind, child.name, name)) out.push({ uri: owner.uri, symbol: child });
      }
    }
    return out;
  }

  /** Membres `name` de n'importe quelle classe du workspace (objet de type inconnu). */
  findMembersAnywhere(name: string, kinds: SymbolKind[], limit = 30): IndexedSymbol[] {
    const out: IndexedSymbol[] = [];
    for (const file of this.workspace.files()) {
      for (const symbol of file.symbols) {
        for (const child of symbol.children ?? []) {
          if (!kinds.includes(child.kind) || !sameMember(child.kind, child.name, name)) continue;
          out.push({ uri: file.uri, symbol: child });
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }
}
