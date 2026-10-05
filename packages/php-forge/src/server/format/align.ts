// Options du formateur sur la mise en page calculée : alignement des `=>` d'un tableau et des `=` d'affectations
// consécutives (jamais au-delà de la longueur de ligne indicative), virgule finale des tableaux sur plusieurs lignes.
import type { Node } from '../parser/parser.ts';
import type { FormatOptions, Layout } from './format.ts';

const length = (layout: Layout, i: number) => layout.tokens[i].end - layout.tokens[i].start;

/** Colonne de début du jeton `index` dans le texte formaté (undefined : ligne avec un jeton sur plusieurs lignes). */
function columnOf(layout: Layout, index: number): number | undefined {
  let column = 0;
  for (let i = index - 1; i >= 0; i--) {
    const gap = layout.wanted[i];
    const newline = gap.lastIndexOf('\n');
    if (newline >= 0) return column + gap.length - newline - 1;
    if (layout.tokens[i].endLine !== layout.tokens[i].line) return undefined;
    column += gap.length + length(layout, i);
  }
  return undefined;
}

/** Longueur du reste de la ligne à partir du jeton `index` (texte formaté). */
function restOf(layout: Layout, index: number): number {
  let n = 0;
  for (let i = index; i < layout.tokens.length; i++) {
    n += length(layout, i);
    const gap = layout.wanted[i] ?? '';
    if (gap.includes('\n') || i === layout.tokens.length - 1) break;
    n += gap.length;
  }
  return n;
}

/** Groupes de lignes consécutives : un opérateur par ligne, même parent (tableau, bloc), en début de ligne. */
function align(layout: Layout, operators: { index: number; group: number; line: number }[], options: FormatOptions): void {
  let run: typeof operators = [];
  const flush = () => {
    if (run.length > 1) {
      const columns = run.map((op) => columnOf(layout, op.index - 1));
      if (columns.every((c) => c !== undefined)) {
        const ends = run.map((op, k) => columns[k]! + length(layout, op.index - 1));
        const target = Math.max(...ends) + 1;
        if (run.every((op) => target + restOf(layout, op.index) <= options.lineLength)) {
          run.forEach((op, k) => (layout.wanted[op.index - 1] = ' '.repeat(target - ends[k])));
        }
      }
    }
    run = [];
  };
  for (const op of operators) {
    const last = run[run.length - 1];
    if (last && (last.group !== op.group || op.line !== last.line + 1)) flush();
    run.push(op);
  }
  flush();
}

/** Le jeton est le premier de sa ligne dans le texte formaté. */
const startsLine = (layout: Layout, index: number) => index === 0 || layout.wanted[index - 1].includes('\n');

/** Premier jeton du nœud. */
function firstToken(layout: Layout, node: Node, from: number): number {
  for (let i = from; i >= 0; i--) if (layout.tokens[i].start === node.startIndex) return i;
  return -1;
}

export function applyOptions(layout: Layout, options: FormatOptions): void {
  const { tokens } = layout;
  if (options.alignArrows) {
    const arrows: { index: number; group: number; line: number }[] = [];
    tokens.forEach((t, i) => {
      const element = t.node.parent;
      if (t.type !== '=>' || element?.type !== 'array_element_initializer' || !element.parent) return;
      const first = firstToken(layout, element, i);
      if (first >= 0 && startsLine(layout, first)) arrows.push({ index: i, group: element.parent.id, line: t.line });
    });
    align(layout, arrows, options);
  }
  if (options.alignAssignments) {
    const assignments: { index: number; group: number; line: number }[] = [];
    tokens.forEach((t, i) => {
      const assignment = t.node.parent;
      const statement = assignment?.parent;
      if (t.type !== '=' || assignment?.type !== 'assignment_expression' || statement?.type !== 'expression_statement' || !statement.parent) return;
      const first = firstToken(layout, statement, i);
      if (first >= 0 && startsLine(layout, first) && tokens[first].line === t.line) assignments.push({ index: i, group: statement.parent.id, line: t.line });
    });
    align(layout, assignments, options);
  }
  if (options.trailingCommas) {
    tokens.forEach((t, i) => {
      const array = t.node.parent;
      if (!(t.type === ']' || t.type === ')') || array?.type !== 'array_creation_expression' || array.lastChild?.id !== t.node.id) return;
      if (!startsLine(layout, i) || i === 0 || tokens[i - 1].type === ',' || tokens[i - 1].node.id === array.firstChild?.id) return;
      layout.wanted[i - 1] = `,${layout.wanted[i - 1]}`;
    });
  }
}
