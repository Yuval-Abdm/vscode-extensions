// Jetons du formateur : feuilles de l'arbre, sauf les nœuds gardés entiers (chaînes, heredoc, commentaires, HTML).
// Le formateur ne réécrit que les espaces entre deux jetons : le texte des jetons ne change jamais.
import type { Node, Tree } from '../parser/parser.ts';

export interface Token {
  node: Node;
  type: string;
  start: number;
  end: number;
  /** Ligne et colonne du début et de la fin */
  line: number;
  column: number;
  endLine: number;
}

/** Nœuds gardés entiers : leur texte intérieur (espaces compris) n'est jamais touché. */
const ATOMIC = new Set(['string', 'encapsed_string', 'heredoc', 'nowdoc', 'comment', 'text', 'shell_command_expression']);

export function tokensOf(tree: Tree): Token[] {
  const out: Token[] = [];
  const cursor = tree.walk();
  let descend = true;
  for (;;) {
    const node = cursor.currentNode;
    if (descend && (node.childCount === 0 || ATOMIC.has(node.type))) {
      if (node.endIndex > node.startIndex) {
        // Un commentaire `//` peut finir par son saut de ligne : il reste dans l'espace qui suit
        const text = node.type === 'comment' ? node.text : '';
        const trailing = /\r?\n$/.exec(text)?.[0].length ?? 0;
        const end = node.endIndex - trailing;
        const endLine = trailing ? node.startPosition.row + (text.slice(0, -trailing).split('\n').length - 1) : node.endPosition.row;
        out.push({ node, type: node.type, start: node.startIndex, end, line: node.startPosition.row, column: node.startPosition.column, endLine });
      }
      descend = false;
    }
    if (descend && cursor.gotoFirstChild()) continue;
    if (cursor.gotoNextSibling()) {
      descend = true;
      continue;
    }
    if (!cursor.gotoParent()) break;
    descend = false;
  }
  cursor.delete();
  return out;
}
