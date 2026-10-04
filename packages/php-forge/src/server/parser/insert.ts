// Analyse d'un texte modifié par une insertion au curseur (et un ajout éventuel en fin de texte) : en repartant
// d'une copie de l'arbre du document, seule la zone modifiée est ré-analysée (fichiers de plusieurs centaines de Ko).
import type { Position } from '../../shared/types.ts';
import { Edit, parsePhp, type Parser, type Tree } from './parser.ts';

export interface BaseTree {
  /** Arbre actuel du document (`text`), copié puis modifié : l'original reste intact */
  tree: Tree;
  /** Position du curseur (`offset`) */
  position: Position;
}

/** Arbre de `text` avec `inserted` à `offset` et `appended` à la fin ; l'appelant le libère. */
export function parseWithInsertion(parser: Parser, text: string, offset: number, inserted: string, appended = '', base?: BaseTree): Tree {
  const patched = text.slice(0, offset) + inserted + text.slice(offset) + appended;
  let old: Tree | undefined;
  if (base) {
    old = base.tree.copy();
    const at = { row: base.position.line, column: base.position.character };
    const after = { row: at.row, column: at.column + inserted.length };
    old.edit(new Edit({ startIndex: offset, oldEndIndex: offset, newEndIndex: offset + inserted.length, startPosition: at, oldEndPosition: at, newEndPosition: after }));
    if (appended) {
      const length = text.length + inserted.length;
      const lastLine = text.lastIndexOf('\n');
      const end = { row: text.split('\n').length - 1, column: text.length - lastLine - 1 + (lastLine < offset ? inserted.length : 0) };
      old.edit(new Edit({ startIndex: length, oldEndIndex: length, newEndIndex: length + appended.length, startPosition: end, oldEndPosition: end, newEndPosition: { row: end.row, column: end.column + appended.length } }));
    }
  }
  try {
    return parsePhp(parser, patched, old);
  } finally {
    old?.delete();
  }
}
