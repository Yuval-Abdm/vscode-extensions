// Requêtes SQL concaténées qui mélangent les guillemets PHP (« 'UPDATE …'.$d." = '"… ») : chaque morceau devrait
// utiliser les mêmes. Les guillemets à l'intérieur d'un morceau sont du SQL, pas concernés, et un
// morceau qui ne fait qu'entourer une valeur (« "'" », « '"' », « "', '" ») est toléré.
import * as l10n from '@vscode/l10n';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import type { DiagnosticFix } from '../diagnostics/tags.ts';
import { rangeOf } from '../model/ranges.ts';
import type { Node, Tree } from '../parser/parser.ts';
import { sqlQueries } from './tokens.ts';

export const SQL_MIXED_QUOTES = 'sql-mixed-quotes';

type Quote = "'" | '"';

/** Morceau sans texte propre : seulement des guillemets, virgules, parenthèses, % et espaces. */
const WRAPPER = /^[\s'"`,()%\\]*$/;

export function sqlQuoteDiagnostics(tree: Tree): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const parts of sqlQueries(tree)) {
    const literals = parts.filter((p) => quoteOf(p));
    if (literals.length < 2) continue;
    const reference = literals.find((p) => !WRAPPER.test(contentText(p)));
    if (!reference) continue;
    const start = quoteOf(reference)!;
    if (literals.every((p) => quoteOf(p) === start || WRAPPER.test(contentText(p)))) continue;

    // Guillemets cibles : ceux qui demandent le moins d'échappements (souvent les doubles, le SQL utilisant
    // des « ' »), ceux du début à égalité ; sans conversion sûre, ceux du début et pas de correction
    const plans = ([start, start === "'" ? '"' : "'"] as Quote[])
      .map((quote) => ({ quote, parts: literals.filter((p) => quoteOf(p) !== quote) }))
      .map((plan) => ({ ...plan, converted: plan.parts.map((p) => convert(p, plan.quote)) }))
      .filter((plan) => plan.converted.every((c) => c !== undefined))
      .map((plan) => ({ ...plan, cost: plan.converted.reduce((n, c, i) => n + backslashes(c!) - backslashes(plan.parts[i].text), 0) }));
    const best = plans.reduce<(typeof plans)[number] | undefined>((a, b) => (!a || b.cost < a.cost ? b : a), undefined);
    const quote = best?.quote ?? start;
    const fixes: DiagnosticFix[] = best
      ? [{
        title: quote === "'" ? l10n.t('Use single quotes throughout the query') : l10n.t('Use double quotes throughout the query'),
        edits: best.parts.map((p, i) => ({ range: rangeOf(p), newText: best.converted[i]! })),
      }]
      : [];
    const flagged = literals.filter((p) => quoteOf(p) !== quote && !WRAPPER.test(contentText(p)));
    for (const part of flagged) {
      out.push({
        range: rangeOf(part),
        message: l10n.t('SQL query mixes PHP quotes: use {0} throughout the query', quote),
        severity: DiagnosticSeverity.Warning,
        source: 'PHP Forge',
        code: SQL_MIXED_QUOTES,
        data: { fixes },
      });
    }
  }
  return out;
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
