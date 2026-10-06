// Fichiers lus et analysés pour les recherches (références, renommage, CodeLens) : gardés quelques instants pour
// que des requêtes voisines (lentilles visibles d'un fichier) ne relisent pas les mêmes fichiers. Une entrée est
// renouvelée quand le résumé du fichier change (fichier modifié sur le disque) ; au-delà de la capacité, la plus
// ancienne est libérée.
import type { FileSymbols } from '../../shared/types.ts';
import type { Tree } from '../parser/parser.ts';
import type { SourceFile } from './references.ts';

interface Entry {
  file: SourceFile;
  /** Utilisations en cours : une entrée utilisée n'est jamais libérée */
  users: number;
  stale: boolean;
}

export class SourceCache {
  readonly #capacity: number;
  readonly #load: (uri: string) => { text: string; tree: Tree } | undefined;
  readonly #entries = new Map<string, Entry>();

  constructor(capacity: number, load: (uri: string) => { text: string; tree: Tree } | undefined) {
    this.#capacity = capacity;
    this.#load = load;
  }

  get(uri: string, symbols: FileSymbols): { file: SourceFile; release(): void } | undefined {
    const cached = this.#entries.get(uri);
    if (cached && cached.file.symbols === symbols) {
      // Plus récemment utilisée : en fin d'ordre
      this.#entries.delete(uri);
      this.#entries.set(uri, cached);
      return this.#use(cached);
    }
    if (cached) this.#drop(uri, cached);
    const loaded = this.#load(uri);
    if (!loaded) return undefined;
    const entry: Entry = { file: { uri, text: loaded.text, tree: loaded.tree, symbols }, users: 0, stale: false };
    this.#entries.set(uri, entry);
    for (const [key, other] of this.#entries) {
      if (this.#entries.size <= this.#capacity) break;
      if (other !== entry) this.#drop(key, other);
    }
    return this.#use(entry);
  }

  clear(): void {
    for (const [uri, entry] of [...this.#entries]) this.#drop(uri, entry);
  }

  #use(entry: Entry): { file: SourceFile; release(): void } {
    entry.users++;
    let released = false;
    return {
      file: entry.file,
      release: () => {
        if (released) return;
        released = true;
        entry.users--;
        if (entry.stale && entry.users === 0) entry.file.tree.delete();
      },
    };
  }

  /** Retirée du cache ; l'arbre est libéré dès qu'il n'est plus utilisé. */
  #drop(uri: string, entry: Entry): void {
    this.#entries.delete(uri);
    entry.stale = true;
    if (entry.users === 0) entry.file.tree.delete();
  }
}
