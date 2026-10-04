// Documents ouverts : texte, arbre ré-analysé de façon incrémentale à chaque modification, résumé à jour.
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { FileSymbols, Range } from '../shared/types.ts';
import { extractFile } from './model/extract.ts';
import { Edit, parsePhp, type Parser, type Tree } from './parser/parser.ts';

export interface OpenDocument {
  uri: string;
  doc: TextDocument;
  tree: Tree;
  symbols: FileSymbols;
  /** Résumé extrait sans les types déduits du code (après une modification) */
  pendingInference: boolean;
}

/** Changement LSP : remplacement d'une plage, ou texte complet si `range` est absent. */
export interface TextChange {
  range?: Range;
  text: string;
}

/** Description tree-sitter d'un remplacement, calculée sur le texte avant modification. */
function editFor(doc: TextDocument, range: Range, text: string): Edit {
  const startIndex = doc.offsetAt(range.start);
  const oldEndIndex = doc.offsetAt(range.end);
  const start = doc.positionAt(startIndex);
  const oldEnd = doc.positionAt(oldEndIndex);
  const lines = text.split('\n');
  const newEndPosition = lines.length === 1
    ? { row: start.line, column: start.character + text.length }
    : { row: start.line + lines.length - 1, column: lines[lines.length - 1].length };
  return new Edit({
    startIndex,
    oldEndIndex,
    newEndIndex: startIndex + text.length,
    startPosition: { row: start.line, column: start.character },
    oldEndPosition: { row: oldEnd.line, column: oldEnd.character },
    newEndPosition,
  });
}

export class DocumentStore {
  readonly #parser: Parser;
  readonly #docs = new Map<string, OpenDocument>();

  constructor(parser: Parser) {
    this.#parser = parser;
  }

  get(uri: string): OpenDocument | undefined {
    return this.#docs.get(uri);
  }

  all(): IterableIterator<OpenDocument> {
    return this.#docs.values();
  }

  open(uri: string, languageId: string, version: number, text: string): OpenDocument {
    this.close(uri);
    const doc = TextDocument.create(uri, languageId, version, text);
    const tree = parsePhp(this.#parser, text);
    const entry: OpenDocument = { uri, doc, tree, symbols: extractFile(tree, uri), pendingInference: false };
    this.#docs.set(uri, entry);
    return entry;
  }

  change(uri: string, version: number, changes: TextChange[]): OpenDocument | undefined {
    const entry = this.#docs.get(uri);
    if (!entry) return undefined;
    let full = false;
    for (const change of changes) {
      if (change.range) {
        if (!full) entry.tree.edit(editFor(entry.doc, change.range, change.text));
        entry.doc = TextDocument.update(entry.doc, [{ range: change.range, text: change.text }], version);
      } else {
        full = true;
        entry.doc = TextDocument.update(entry.doc, [{ text: change.text }], version);
      }
    }
    const old = entry.tree;
    entry.tree = parsePhp(this.#parser, entry.doc.getText(), full ? undefined : old);
    old.delete();
    // Les types déduits coûtent cher sur les gros fichiers sans types : calculés plus tard (inferTypes)
    entry.symbols = extractFile(entry.tree, uri, { infer: false });
    entry.pendingInference = true;
    return entry;
  }

  /** Types déduits du code d'un document modifié ; undefined s'il n'y a rien à faire. */
  inferTypes(uri: string): OpenDocument | undefined {
    const entry = this.#docs.get(uri);
    if (!entry?.pendingInference) return undefined;
    entry.symbols = extractFile(entry.tree, uri);
    entry.pendingInference = false;
    return entry;
  }

  close(uri: string): void {
    this.#docs.get(uri)?.tree.delete();
    this.#docs.delete(uri);
  }
}
