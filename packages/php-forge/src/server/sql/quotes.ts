// Concaténations qui mélangent les guillemets PHP : requêtes SQL (« 'UPDATE …'.$d." = '"… », sql-mixed-quotes) et
// autres chaînes (« "de la " . $x . ' y se encuentra en ' », mixed-quotes). Chaque morceau devrait utiliser les
// mêmes. Les guillemets à l'intérieur d'un morceau ne sont pas concernés, et un morceau qui ne fait qu'entourer une
// valeur (« "'" », « '"' », « "', '" », et hors SQL « "\n" ») est toléré.
import * as l10n from '@vscode/l10n';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import type { DiagnosticFix } from '../diagnostics/tags.ts';
import { rangeOf } from '../model/ranges.ts';
import type { Node, Tree } from '../parser/parser.ts';
import { sqlQueries, textConcatenations } from './tokens.ts';

export const SQL_MIXED_QUOTES = 'sql-mixed-quotes';
export const MIXED_QUOTES = 'mixed-quotes';

type Quote = "'" | '"';

/** Morceau sans texte propre : seulement des guillemets, virgules, parenthèses, % et espaces. */
const WRAPPER = /^[\s'"`,()%\\]*$/;
/** Hors SQL, aussi : séquences d'échappement seules (« "\n" », « "\r\n\t" »), qui demandent des doubles */
const ESCAPES = /^(?:[\s'"`,()%]|\\[nrtv0e])*$/;

export function sqlQuoteDiagnostics(tree: Tree): Diagnostic[] {
  return sqlQueries(tree).flatMap((parts) => mixed(parts, {
    code: SQL_MIXED_QUOTES,
    tie: 'start',
    wrapper: WRAPPER,
    message: (quote) => l10n.t('SQL query mixes PHP quotes: use {0} throughout the query', quote),
    title: (quote) => (quote === "'" ? l10n.t('Use single quotes throughout the query') : l10n.t('Use double quotes throughout the query')),
  }));
}

/** Concaténations de chaînes hors SQL qui mélangent les guillemets. */
export function mixedQuoteDiagnostics(tree: Tree): Diagnostic[] {
  return textConcatenations(tree).flatMap((parts) => mixed(parts, {
    code: MIXED_QUOTES,
    tie: '"',
    wrapper: ESCAPES,
    message: (quote) => l10n.t('String concatenation mixes PHP quotes: use {0} throughout', quote),
    title: (quote) => (quote === "'" ? l10n.t('Use single quotes throughout the concatenation') : l10n.t('Use double quotes throughout the concatenation')),
  }));
}

interface Rule {
  code: string;
  /** Guillemets choisis quand les deux demandent autant d'échappements : ceux du début, ou les doubles */
  tie: 'start' | Quote;
  /** Morceau toléré : il ne fait qu'entourer une valeur */
  wrapper: RegExp;
  message: (quote: Quote) => string;
  title: (quote: Quote) => string;
}

function mixed(parts: Node[], rule: Rule): Diagnostic[] {
  const literals = parts.filter((p) => quoteOf(p));
  if (literals.length < 2) return [];
  const reference = literals.find((p) => !rule.wrapper.test(contentText(p)));
  if (!reference) return [];
  const start = quoteOf(reference)!;
  if (literals.every((p) => quoteOf(p) === start || rule.wrapper.test(contentText(p)))) return [];

  // Guillemets cibles : ceux qui demandent le moins d'échappements (souvent les doubles, le SQL utilisant
  // des « ' »), à égalité ceux de la règle ; sans conversion sûre, ceux du début et pas de correction
  const first: Quote = rule.tie === 'start' ? start : rule.tie;
  const plans = ([first, first === "'" ? '"' : "'"] as Quote[])
    .map((quote) => ({ quote, parts: literals.filter((p) => quoteOf(p) !== quote) }))
    .map((plan) => ({ ...plan, converted: plan.parts.map((p) => convert(p, plan.quote)) }))
    .filter((plan) => plan.converted.every((c) => c !== undefined))
    .map((plan) => ({ ...plan, cost: plan.converted.reduce((n, c, i) => n + backslashes(c!) - backslashes(plan.parts[i].text), 0) }));
  const best = plans.reduce<(typeof plans)[number] | undefined>((a, b) => (!a || b.cost < a.cost ? b : a), undefined);
  const quote = best?.quote ?? start;
  const fixes: DiagnosticFix[] = best ? [{ title: rule.title(quote), edits: best.parts.map((p, i) => ({ range: rangeOf(p), newText: best.converted[i]! })) }] : [];
  return literals
    .filter((p) => quoteOf(p) !== quote && !rule.wrapper.test(contentText(p)))
    .map((part) => ({ range: rangeOf(part), message: rule.message(quote), severity: DiagnosticSeverity.Warning, source: 'PHP Forge', code: rule.code, data: { fixes } }));
}

function quoteOf(literal: Node): Quote | undefined {
  if (literal.type === 'string' && literal.text.startsWith("'")) return "'";
  if (literal.type === 'encapsed_string' && literal.text.startsWith('"')) return '"';
  return undefined;
}

function contentText(literal: Node): string {
  return literal.text.slice(1, -1);
}

/** Même valeur avec l'autre guillemet, si la conversion est sûre (pas d'interpolation, pas d'autre séquence). */
function convert(literal: Node, to: Quote): string | undefined {
  let out = '';
  for (const child of literal.namedChildren) {
    if (child.type === 'escape_sequence') {
      const char = child.text.slice(1);
      if (char === '\\') out += '\\\\';
      else if (char === "'" || char === '"' || char === '$') out += escape(char, to);
      else return undefined;
    } else if (child.type === 'string_content') {
      if (child.text.includes('\\')) return undefined;
      for (const char of child.text) out += escape(char, to);
    } else {
      return undefined;
    }
  }
  return to + out + to;
}

function backslashes(text: string): number {
  return text.split('\\').length - 1;
}

function escape(char: string, to: Quote): string {
  if (char === to) return `\\${char}`;
  if (to === '"' && char === '$') return '\\$';
  return char;
}
