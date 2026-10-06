// Formateur à base de jetons : seuls les espaces entre deux jetons sont réécrits (espaces d'une ligne, indentation,
// place des accolades), jamais le texte d'un jeton ; le HTML, les chaînes, les heredoc et l'intérieur des
// commentaires sont gardés (sauf l'alignement des lignes « * » d'un commentaire /** */ réindenté). Un fichier avec une
// erreur de syntaxe n'est pas formaté.
import type { Range, TextEdit } from 'vscode-languageserver/node';
import type { Node, Tree } from '../parser/parser.ts';
import { applyOptions } from './align.ts';
import { Indenter } from './indent.ts';
import { spacing } from './spacing.ts';
import { atomOf, tokenOf, tokensOf, type Token } from './tokens.ts';

export interface FormatOptions {
  /** Unité d'indentation (« 4 espaces » ou tabulation) */
  unit: string;
  /** psr12 : accolade des classes et fonctions à la ligne, des structures de contrôle sur la ligne ; keep : inchangé */
  braces: 'psr12' | 'keep';
  alignArrows: boolean;
  alignAssignments: boolean;
  trailingCommas: boolean;
  lineLength: number;
}

export const DEFAULT_FORMAT: FormatOptions = { unit: '    ', braces: 'psr12', alignArrows: false, alignAssignments: false, trailingCommas: false, lineLength: 120 };

const DECLARATIONS = new Set(['class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration', 'function_definition', 'method_declaration']);
const CONTROL_BODIES = new Set(['if_statement', 'else_clause', 'else_if_clause', 'while_statement', 'do_statement', 'for_statement', 'foreach_statement', 'switch_statement', 'try_statement', 'catch_clause', 'finally_clause']);

export interface Layout {
  tokens: Token[];
  /** Espace actuel et espace voulu entre le jeton i et le jeton i + 1 */
  current: string[];
  wanted: string[];
  /** Modifications à l'intérieur des commentaires (lignes « * ») */
  inner: TextEdit[];
}

function positionAt(starts: number[], index: number): { line: number; character: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: index - starts[lo] };
}

/** Accolade ouvrante d'une classe ou d'une fonction (à la ligne en PSR-12), d'une structure de contrôle (sur la ligne). */
function braceKind(token: Token): 'declaration' | 'control' | undefined {
  if (token.type !== '{') return undefined;
  const block = token.node.parent;
  const owner = block?.parent;
  if (!block || !owner) return undefined;
  if (block.type === 'declaration_list' || block.type === 'enum_declaration_list') return DECLARATIONS.has(owner.type) ? 'declaration' : undefined;
  if (block.type === 'compound_statement') {
    if (DECLARATIONS.has(owner.type)) return 'declaration';
    if (CONTROL_BODIES.has(owner.type)) return 'control';
  }
  if (block.type === 'switch_block') return 'control';
  return undefined;
}

type Decision = { kind: 'keep' } | { kind: 'same'; text: string } | { kind: 'break'; count: number };

/**
 * Jetons d'une partie du fichier (formatage à la frappe) : ceux du nœud, précédés du jeton qui le précède (pour
 * l'indentation de sa première ligne) et de la balise `<?php` de sa région.
 */
function windowTokens(tree: Tree, text: string, window: Node): Token[] {
  const out = tokensOf(window);
  let p = window.startIndex - 1;
  while (p >= 0 && /\s/.test(text[p])) p--;
  if (p < 0) return out;
  const leaf = tree.rootNode.descendantForIndex(p, p + 1);
  if (!leaf) return out;
  const previous = atomOf(leaf);
  out.unshift(tokenOf(previous));
  const tag = tree.rootNode.descendantsOfType('php_tag').filter((t) => t.startIndex < previous.startIndex).at(-1);
  if (tag) out.unshift(tokenOf(tag));
  return out;
}

export function layout(tree: Tree, text: string, options: FormatOptions, window?: Node): Layout | undefined {
  if (tree.rootNode.hasError) return undefined;
  const tokens = window ? windowTokens(tree, text, window) : tokensOf(tree);
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const current: string[] = [];
  // 1. Pour chaque espace entre deux jetons : inchangé, sur la ligne, ou N sauts de ligne
  const decisions: Decision[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const left = tokens[i];
    const right = tokens[i + 1];
    const gap = text.slice(left.end, right.start);
    current.push(gap);
    decisions.push(decide(left, right, gap, options));
  }
  // 2. Lignes du texte formaté
  const outLine: number[] = [0];
  const heads: boolean[] = [true];
  for (let i = 0; i < decisions.length; i++) {
    const d = decisions[i];
    const breaks = d.kind === 'break' ? d.count : d.kind === 'keep' ? current[i].split('\n').length - 1 : 0;
    outLine.push(outLine[i] + (tokens[i].endLine - tokens[i].line) + breaks);
    heads.push(d.kind === 'break');
  }
  // 3. Indentation des lignes, texte des espaces
  const indenter = new Indenter({ tokens, outLine, heads, lines, unit: options.unit });
  const wanted = decisions.map((d, i) => {
    if (d.kind === 'keep') return current[i];
    if (d.kind === 'same') return d.text;
    return eol.repeat(d.count) + (indenter.reindents(i + 1) ? indenter.indent(i + 1) : /^[ \t]*/.exec(lines[tokens[i + 1].line] ?? '')![0]);
  });
  // Commentaires /** */ réindentés : lignes « * » alignées sous le « / »
  const inner: TextEdit[] = [];
  tokens.forEach((token, i) => {
    if (token.type !== 'comment' || token.endLine === token.line || !indenter.reindents(i) || !token.node.text.startsWith('/*')) return;
    const indent = indenter.indent(i);
    for (let line = token.line + 1; line <= token.endLine; line++) {
      const match = /^[ \t]*(?=\*)/.exec(lines[line]);
      if (!match || match[0] === `${indent} `) continue;
      inner.push({ range: { start: { line, character: 0 }, end: { line, character: match[0].length } }, newText: `${indent} ` });
    }
  });
  const result = { tokens, current, wanted, inner };
  applyOptions(result, options);
  return result;
}

function decide(left: Token, right: Token, gap: string, options: FormatOptions): Decision {
  // Autour du HTML et des balises de fin : PHP mange le saut de ligne qui suit `?>`, rien n'est touché
  if (/\S/.test(gap) || left.type === 'text' || right.type === 'text' || left.type === 'php_end_tag' || right.type === 'php_tag') return { kind: 'keep' };
  const newlines = gap.split('\n').length - 1;
  const brace = options.braces === 'psr12' ? braceKind(right) : undefined;
  const joinElse = options.braces === 'psr12' && left.type === '}' && /^(else|elseif|catch|finally)$/i.test(right.type) && left.node.parent?.type === 'compound_statement';
  if (brace === 'declaration' && right.node.parent?.parent?.type !== 'anonymous_class' && !isOneLiner(right)) return { kind: 'break', count: 1 };
  if (newlines > 0 && (brace === 'control' || joinElse) && left.type !== 'comment') return { kind: 'same', text: ' ' };
  if (newlines === 0) return { kind: 'same', text: spacing(left, right, gap) };
  return { kind: 'break', count: newlines };
}

/** Corps écrit sur une ligne (`function f() { return 1; }`, `class E {}`) : laissé sur la ligne. */
function isOneLiner(brace: Token): boolean {
  return brace.node.parent!.endPosition.row === brace.line;
}

/** Modifications du document entier. */
/** `window` : nœud qui contient la plage, seul mis en page (formatage à la frappe sur un gros fichier). */
export function formatEdits(tree: Tree, text: string, options: FormatOptions, range?: Range, window?: Node): TextEdit[] {
  const result = layout(tree, text, options, window);
  if (!result) return [];
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const out: TextEdit[] = [];
  const inRange = (line: number) => !range || (line >= range.start.line && line <= range.end.line);
  result.wanted.forEach((gap, i) => {
    if (gap === result.current[i]) return;
    const start = result.tokens[i].end;
    const end = result.tokens[i + 1].start;
    const startPos = positionAt(starts, start);
    const endPos = positionAt(starts, end);
    if (!inRange(endPos.line) && !inRange(startPos.line)) return;
    out.push({ range: { start: startPos, end: endPos }, newText: gap });
  });
  for (const edit of result.inner) if (inRange(edit.range.start.line)) out.push(edit);
  return out;
}

/** Texte formaté (tests, mesure). */
export function formatText(tree: Tree, text: string, options: FormatOptions): string {
  const result = layout(tree, text, options);
  if (!result) return text;
  let out = '';
  let last = 0;
  const pieces: { start: number; end: number; text: string }[] = [];
  result.wanted.forEach((gap, i) => {
    if (gap !== result.current[i]) pieces.push({ start: result.tokens[i].end, end: result.tokens[i + 1].start, text: gap });
  });
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  for (const edit of result.inner) {
    const start = starts[edit.range.start.line] + edit.range.start.character;
    pieces.push({ start, end: starts[edit.range.end.line] + edit.range.end.character, text: edit.newText });
  }
  pieces.sort((a, b) => a.start - b.start);
  for (const piece of pieces) {
    out += text.slice(last, piece.start) + piece.text;
    last = piece.end;
  }
  return out + text.slice(last);
}

/** Réglages `phpForge.format` (sans l'indentation, qui vient de l'éditeur). */
export interface FormatSettings {
  enable: boolean;
  braces: 'psr12' | 'keep';
  alignArrows: boolean;
  alignAssignments: boolean;
  trailingCommas: boolean;
  lineLength: number;
}

/** Options du formateur : réglages + indentation de l'éditeur (tabSize, insertSpaces). */
export function formatOptions(settings: FormatSettings, editor: { tabSize: number; insertSpaces: boolean }): FormatOptions {
  const { enable: _enable, ...rest } = settings;
  return { ...rest, unit: editor.insertSpaces ? ' '.repeat(editor.tabSize) : '\t' };
}

/** Lignes à reformater après la frappe de `;` (la ligne) ou de `}` (le bloc qu'elle ferme). */
export function onTypeRange(tree: Tree, position: { line: number; character: number }, ch: string): Range {
  const line: Range = { start: { line: position.line, character: 0 }, end: { line: position.line, character: position.character } };
  if (ch !== '}' || position.character === 0) return line;
  const brace = tree.rootNode.descendantForPosition({ row: position.line, column: position.character - 1 });
  const block = brace?.type === '}' ? brace.parent : null;
  return block ? { start: { line: block.startPosition.row, character: 0 }, end: line.end } : line;
}

const CONTAINERS = new Set(['program', 'compound_statement', 'declaration_list', 'colon_block', 'switch_block', 'case_statement', 'default_statement', 'text_interpolation']);

/** Instruction (ou déclaration) qui contient toute la plage : seule partie mise en page à la frappe. */
export function onTypeWindow(tree: Tree, range: Range): Node | undefined {
  let node: Node | null = tree.rootNode.descendantForPosition({ row: range.end.line, column: Math.max(0, range.end.character - 1) });
  // Position après la fin de la ligne : on tombe sur le bloc, on redescend vers la dernière instruction de la ligne
  while (node && CONTAINERS.has(node.type)) {
    const child: Node | undefined = node.namedChildren.filter((c) => c.startPosition.row <= range.end.line).at(-1);
    if (!child || child.endPosition.row < range.end.line) break;
    node = child;
  }
  while (node && node.parent && !(CONTAINERS.has(node.parent.type) && node.startPosition.row <= range.start.line)) node = node.parent;
  return node && node.type !== 'program' && node.parent ? node : undefined;
}
