// Erreurs de syntaxe : nœuds ERROR (le plus externe seulement, limité à sa première ligne) et MISSING.
// Avec l'analyseur, un « ; » oublié est reconnu : tree-sitter le signale souvent comme un élément inattendu
// sur la ligne suivante ; on ajoute « ; » en fin de ligne et, si l'erreur disparaît, c'est bien la cause.
import * as l10n from '@vscode/l10n';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import type { Position, Range } from '../../shared/types.ts';
import { rangeOf } from '../model/ranges.ts';
import type { Node, Parser, Tree } from '../parser/parser.ts';
import { parseWithInsertion } from '../parser/insert.ts';

export const MISSING_SEMICOLON = 'missing-semicolon';

/** Nombre maximal de ré-analyses pour chercher des « ; » manquants (chacune ne ré-analyse que la zone modifiée). */
const MAX_ATTEMPTS = 10;
/** Fins de ligne après lesquelles un « ; » n'a pas de sens. */
const NO_SEMICOLON_AFTER = /(?:[;{},([]|<\?(?:php)?)$/i;

export function syntaxDiagnostics(tree: Tree, max = 100, parser?: Parser): Diagnostic[] {
  const found = collect(tree, max);
  if (!parser || found.length === 0) return found;
  return withMissingSemicolons(tree, parser, found);
}

function collect(tree: Tree, max: number): Diagnostic[] {
  const out: Diagnostic[] = [];
  const visit = (node: Node): void => {
    if (out.length >= max) return;
    if (node.isMissing) {
      const range = rangeOf(node);
      out.push(node.type === ';' ? missingSemicolon(range.start) : diagnostic(range, l10n.t('Syntax error: missing "{0}"', node.type)));
      return;
    }
    if (node.isError) {
      out.push(diagnostic(firstLine(node), l10n.t('Syntax error: unexpected "{0}"', firstToken(node))));
      return;
    }
    if (!node.hasError) return;
    for (const child of node.children) visit(child);
  };
  visit(tree.rootNode);
  return out;
}

function withMissingSemicolons(tree: Tree, parser: Parser, found: Diagnostic[]): Diagnostic[] {
  const text = tree.rootNode.text;
  const lines = text.split('\n');
  const lineStarts: number[] = [0];
  for (const line of lines) lineStarts.push(lineStarts[lineStarts.length - 1] + line.length + 1);
  const key = (d: Diagnostic) => `${d.range.start.line}:${d.range.start.character}:${d.message}`;
  const removed = new Set<string>();
  const fixes: Diagnostic[] = [];
  const tried = new Set<number>();
  let attempts = 0;

  for (const error of found) {
    if (error.code !== 'syntax-error' || removed.has(key(error))) continue;
    const line = error.range.start.line;
    for (const candidate of [line, previousCodeLine(lines, line)]) {
      if (candidate < 0 || tried.has(candidate) || attempts >= MAX_ATTEMPTS) continue;
      const at = semicolonPosition(tree, lines, candidate);
      if (!at) continue;
      tried.add(candidate);
      attempts++;
      const patched = parseWithInsertion(parser, text, lineStarts[at.line] + at.character, ';', '', { tree, position: at });
      let after: Diagnostic[];
      try {
        after = collect(patched, found.length + 1);
      } finally {
        patched.delete();
      }
      // L'ajout corrige l'erreur sans en créer d'autre jusqu'à la ligne de l'erreur
      const before = new Set(found.map(key));
      const fixed = after.length < found.length && !after.some((d) => d.range.start.line <= line && !before.has(key(d)));
      if (!fixed) continue;
      const remaining = new Set(after.map(key));
      for (const d of found) if (!remaining.has(key(d))) removed.add(key(d));
      fixes.push(missingSemicolon(at));
      break;
    }
  }
  if (fixes.length === 0) return found;
  const kept = found.filter((d) => !removed.has(key(d)) && !(d.code === MISSING_SEMICOLON && fixes.some((f) => sameRange(f, d))));
  return [...kept, ...fixes].sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
}

/** Ligne de code précédente (hors lignes vides et commentaires seuls). */
function previousCodeLine(lines: string[], line: number): number {
  for (let l = line - 1; l >= 0; l--) {
    const trimmed = lines[l].trim();
    if (trimmed && !/^(?:\/\/|#|\/?\*)/.test(trimmed)) return l;
  }
  return -1;
}

/** Fin du code de la ligne (avant un commentaire final), si un « ; » peut y être ajouté. */
function semicolonPosition(tree: Tree, lines: string[], line: number): Position | undefined {
  let code = lines[line].replace(/\s+$/, '');
  if (!code) return undefined;
  const last = tree.rootNode.descendantForPosition({ row: line, column: code.length - 1 });
  if (last?.type === 'comment' && last.startPosition.row === line) code = code.slice(0, last.startPosition.column).replace(/\s+$/, '');
  if (!code.trim() || NO_SEMICOLON_AFTER.test(code)) return undefined;
  return { line, character: code.length };
}

function sameRange(a: Diagnostic, b: Diagnostic): boolean {
  return a.range.end.line === b.range.end.line && a.range.end.character === b.range.end.character;
}

function missingSemicolon(at: Position): Diagnostic {
  return {
    range: { start: { line: at.line, character: Math.max(0, at.character - 1) }, end: at },
    message: l10n.t('Missing ";" at end of line'),
    severity: DiagnosticSeverity.Error,
    source: 'PHP Forge',
    code: MISSING_SEMICOLON,
  };
}

function diagnostic(range: Range, message: string): Diagnostic {
  return { range, message, severity: DiagnosticSeverity.Error, source: 'PHP Forge', code: 'syntax-error' };
}

function firstLine(node: Node): Range {
  const range = rangeOf(node);
  if (range.start.line === range.end.line) return range;
  const length = node.text.split('\n')[0].length;
  return { start: range.start, end: { line: range.start.line, character: range.start.character + length } };
}

function firstToken(node: Node): string {
  let leaf = node;
  while (leaf.childCount > 0) leaf = leaf.child(0)!;
  return (leaf.text || node.text).trim().slice(0, 30);
}
