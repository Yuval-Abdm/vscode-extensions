// Texte SQL d'une requête trouvée dans le code : morceaux des chaînes mis bout à bout, chaque partie calculée
// (variable interpolée, expression concaténée) remplacée par un trou `?n?` ; chaque caractère garde sa position
// dans le document, pour situer les diagnostics, la complétion et le survol.
import type { Node } from '../parser/parser.ts';
import { contentOf, type SqlQuery } from './tokens.ts';

export interface SqlText {
  text: string;
  /** Position dans le document (index du texte PHP) de chaque caractère, plus la fin */
  source: number[];
  /** Nombre de trous (parties calculées) */
  holes: number;
}

const LITERALS = new Set(['string', 'encapsed_string', 'heredoc', 'nowdoc']);
/** Un trou : jamais du SQL, toujours un seul « mot » pour l'analyse */
export const HOLE = /\?\d+\?/y;

export function sqlText(query: SqlQuery): SqlText {
  let text = '';
  const source: number[] = [];
  let holes = 0;
  const hole = (node: Node) => {
    const mark = `?${holes++}?`;
    for (let i = 0; i < mark.length; i++) source.push(i === 0 ? node.startIndex : node.endIndex);
    text += mark;
  };
  for (const part of query.parts) {
    if (!LITERALS.has(part.type)) {
      hole(part);
      continue;
    }
    const holder = part.type === 'heredoc' || part.type === 'nowdoc' ? part.namedChildren.find((c) => c.type.endsWith('_body')) : part;
    const pieces = (holder?.namedChildren ?? []).filter((c) => c.type !== 'heredoc_start' && c.type !== 'heredoc_end');
    const content = new Set(contentOf(part).map((c) => c.id));
    for (const piece of pieces) {
      if (piece.type === 'string_content') {
        for (let i = 0; i < piece.text.length; i++) source.push(piece.startIndex + i);
        text += piece.text;
      } else if (piece.type === 'escape_sequence' && content.has(piece.id)) {
        // \' \" \n… : le caractère voulu, situé sur la séquence
        const char = ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[piece.text.slice(1)] ?? piece.text.slice(1, 2);
        source.push(piece.startIndex);
        text += char;
      } else {
        hole(piece);
      }
    }
    // Séparation entre deux morceaux : la concaténation PHP ne met rien, le SQL non plus
  }
  source.push(query.root.endIndex);
  return { text, source, holes };
}

/** Index SQL du caractère placé à `index` dans le document (undefined : hors du texte de la requête). */
export function sqlOffset(sql: SqlText, index: number): number | undefined {
  for (let i = 0; i < sql.source.length - 1; i++) {
    if (sql.source[i] === index) return i;
    // Juste après le dernier caractère d'un morceau (curseur en fin de chaîne)
    if (sql.source[i] + 1 === index && (i + 1 === sql.source.length - 1 || sql.source[i + 1] !== index)) return i + 1;
  }
  return undefined;
}
