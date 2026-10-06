// Index des déclarations : résumé par fichier et tables de recherche par nom complet.
// Classes et fonctions : casse ignorée (comme PHP) ; constantes : namespace sans casse, nom exact.
import type { FileSymbols, PhpSymbol, SymbolKind } from '../../shared/types.ts';

export interface IndexedSymbol {
  uri: string;
  symbol: PhpSymbol;
}

type TableName = 'class' | 'function' | 'constant';

const TABLE_OF: Partial<Record<SymbolKind, TableName>> = {
  class: 'class',
  interface: 'class',
  trait: 'class',
  enum: 'class',
  function: 'function',
  constant: 'constant',
};

export function constantKey(fqn: string): string {
  const i = fqn.lastIndexOf('\\');
  return i < 0 ? fqn : `${fqn.slice(0, i).toLowerCase()}\\${fqn.slice(i + 1)}`;
}

const keyOf = (table: TableName, fqn: string) => (table === 'constant' ? constantKey(fqn) : fqn.toLowerCase());

export class SymbolIndex {
  readonly #files = new Map<string, FileSymbols>();
  readonly #tables: Record<TableName, Map<string, IndexedSymbol[]>> = { class: new Map(), function: new Map(), constant: new Map() };

  get size(): number {
    return this.#files.size;
  }

  files(): IterableIterator<FileSymbols> {
    return this.#files.values();
  }

  get(uri: string): FileSymbols | undefined {
    return this.#files.get(uri);
  }

  set(file: FileSymbols): void {
    this.delete(file.uri);
    this.#files.set(file.uri, file);
    for (const symbol of file.symbols) {
      const table = TABLE_OF[symbol.kind];
      if (!table || !symbol.fqn) continue;
      const key = keyOf(table, symbol.fqn);
      const entry = { uri: file.uri, symbol };
      const list = this.#tables[table].get(key);
      if (list) list.push(entry);
      else this.#tables[table].set(key, [entry]);
    }
  }

  delete(uri: string): void {
    const old = this.#files.get(uri);
    if (!old) return;
    this.#files.delete(uri);
    for (const symbol of old.symbols) {
      const table = TABLE_OF[symbol.kind];
      if (!table || !symbol.fqn) continue;
      const key = keyOf(table, symbol.fqn);
      const rest = this.#tables[table].get(key)?.filter((e) => e.uri !== uri) ?? [];
      if (rest.length) this.#tables[table].set(key, rest);
      else this.#tables[table].delete(key);
    }
  }

  clear(): void {
    this.#files.clear();
    for (const table of Object.values(this.#tables)) table.clear();
  }

  findClass(fqn: string): IndexedSymbol[] {
    return this.#tables.class.get(fqn.toLowerCase()) ?? [];
  }

  findFunction(fqn: string): IndexedSymbol[] {
    return this.#tables.function.get(fqn.toLowerCase()) ?? [];
  }

  findConstant(fqn: string): IndexedSymbol[] {
    return this.#tables.constant.get(constantKey(fqn)) ?? [];
  }
}
