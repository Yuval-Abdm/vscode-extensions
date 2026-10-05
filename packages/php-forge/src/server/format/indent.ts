// Indentation d'une ligne qui commence par un jeton PHP : un niveau de plus que la ligne où s'ouvre le bloc qui la
// contient (accolades, parenthèses, crochets, `case`, syntaxe `if (…):`) ; une fermeture revient au niveau de la
// ligne d'ouverture ; la suite d'une instruction sur plusieurs lignes prend un niveau de plus. Au niveau du fichier,
// l'indentation de base est celle de la ligne de la balise `<?php` (fichiers mêlés de HTML). Les lignes sont celles
// du texte formaté (accolades déplacées, `} else {` rejoints).
import type { Node } from '../parser/parser.ts';
import type { Token } from './tokens.ts';

const BLOCKS = new Set([
  'compound_statement', 'declaration_list', 'enum_declaration_list', 'switch_block', 'match_block', 'colon_block', 'case_statement',
  'default_statement', 'arguments', 'formal_parameters', 'array_creation_expression', 'parenthesized_expression', 'list_literal',
  'namespace_use_group', 'anonymous_function_use_clause', 'use_list', 'attribute_group',
]);
const CLOSING = new Set(['}', ')', ']']);
/** Structures dont une ligne suivante n'est pas une suite d'instruction (else, accolade d'une fonction…) */
const STRUCTURES = new Set([
  'if_statement', 'while_statement', 'do_statement', 'for_statement', 'foreach_statement', 'switch_statement', 'try_statement',
  'function_definition', 'class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration', 'method_declaration',
  'namespace_definition', 'declare_statement', 'compound_statement', 'text_interpolation', 'case_statement', 'default_statement',
]);
const NOT_PHP = new Set(['text', 'php_tag', 'php_end_tag']);

export interface IndentContext {
  tokens: Token[];
  /** Ligne du texte formaté de chaque jeton */
  outLine: number[];
  /** Le jeton commence une ligne du texte formaté après un saut de ligne réécrit par le formateur */
  heads: boolean[];
  lines: string[];
  unit: string;
}

const leading = (line: string | undefined) => /^[ \t]*/.exec(line ?? '')![0];

export class Indenter {
  readonly #ctx: IndentContext;
  readonly #cache = new Map<number, string>();
  readonly #firstToken = new Map<number, number>();
  /** Dernière balise `<?php` avant chaque jeton (-1 : aucune) */
  readonly #tags: number[] = [];

  constructor(ctx: IndentContext) {
    this.#ctx = ctx;
    let tag = -1;
    ctx.tokens.forEach((t, i) => {
      if (!this.#firstToken.has(t.start)) this.#firstToken.set(t.start, i);
      this.#tags.push(tag);
      if (t.type === 'php_tag') tag = i;
    });
  }

  /** Le jeton `i` commence une ligne réindentée par le formateur. */
  reindents(i: number): boolean {
    return this.#ctx.heads[i] && !NOT_PHP.has(this.#ctx.tokens[i].type);
  }

  /** Indentation de la ligne (du texte formaté) qui contient le jeton `i`. */
  lineOf(i: number): string {
    const { tokens, outLine } = this.#ctx;
    let h = i;
    while (h > 0 && outLine[h - 1] === outLine[h]) h--;
    if (h > 0 && tokens[h - 1].endLine !== tokens[h - 1].line && outLine[h - 1] !== outLine[h] && !this.#ctx.heads[h]) {
      // La ligne commence à l'intérieur d'un jeton sur plusieurs lignes (HTML, commentaire) : espaces d'origine
      return leading(this.#ctx.lines[tokens[h - 1].endLine]);
    }
    return this.indent(h);
  }

  /** Indentation d'un jeton en tête de ligne. */
  indent(i: number): string {
    const cached = this.#cache.get(i);
    if (cached !== undefined) return cached;
    const original = leading(this.#ctx.lines[this.#ctx.tokens[i].line]);
    this.#cache.set(i, original);
    const value = this.reindents(i) ? this.#compute(i) : original;
    this.#cache.set(i, value);
    return value;
  }

  #first(node: Node): number {
    return this.#firstToken.get(node.startIndex) ?? 0;
  }

  #compute(i: number): string {
    const { tokens, outLine, unit } = this.#ctx;
    const token = tokens[i];
    const node = token.node;
    const line = outLine[i];
    // Fermeture d'un bloc : niveau de sa ligne d'ouverture
    if (CLOSING.has(token.type) && node.parent && BLOCKS.has(node.parent.type) && node.parent.lastChild?.id === node.id) {
      return this.lineOf(this.#first(node.parent));
    }
    // Bloc qui contient la ligne, ouvert sur une ligne précédente
    let block: Node | null = node.parent;
    let child: Node = node;
    while (block && block.type !== 'program' && !(BLOCKS.has(block.type) && outLine[this.#first(block)] < line)) {
      child = block;
      block = block.parent;
    }
    // Un bloc ouvert avant la balise <?php de la région (il enjambe du HTML) : la région donne la base
    const region = this.#regionTag(i);
    const inBlock = !!block && block.type !== 'program' && this.#first(block) > region;
    const base = inBlock ? this.lineOf(this.#first(block!)) + unit : this.#regionBase(region);
    // Suite d'une instruction ou d'une expression commencée plus haut
    const continued = child.id !== node.id && outLine[this.#first(child)] < line && !STRUCTURES.has(child.type) && !isClause(node);
    return continued ? base + unit : base;
  }

  /** Balise `<?php` qui ouvre la région du jeton (-1 : aucune). */
  #regionTag(i: number): number {
    return this.#tags[i];
  }

  /**
   * Base d'une région : l'indentation de la ligne de sa balise `<?php` ; un niveau de plus quand la balise suit du
   * HTML sur sa ligne (`<td><?php`).
   */
  #regionBase(tag: number): string {
    if (tag < 0) return '';
    const token = this.#ctx.tokens[tag];
    const before = (this.#ctx.lines[token.line] ?? '').slice(0, token.column);
    return this.lineOf(tag) + (before.trim() === '' ? '' : this.#ctx.unit);
  }
}

/** else, elseif, catch, finally, endif… : partie d'une structure, pas une suite. */
function isClause(node: Node): boolean {
  if (/^(else|elseif|catch|finally|endif|endforeach|endwhile|endfor|endswitch|enddeclare)$/i.test(node.type)) return true;
  const parent = node.parent;
  return !!parent && /^(else_clause|else_if_clause|catch_clause|finally_clause)$/.test(parent.type) && parent.firstChild?.id === node.id;
}
