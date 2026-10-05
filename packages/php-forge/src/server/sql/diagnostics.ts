// Diagnostics SQL : erreurs de syntaxe sûres (parenthèses ou guillemet non fermés dans une requête entière, virgule
// avant FROM / WHERE, WHERE suivi de AND / OR), tables inconnues (schéma venu de la base seulement : une liste
// lue dans des fichiers .sql peut être partielle) et colonnes inconnues (tables dont toutes les colonnes sont
// connues). Rien n'est signalé à travers une partie calculée en PHP.
import * as l10n from '@vscode/l10n';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import type { Tree } from '../parser/parser.ts';
import { analyzeSql, lex, type SqlAnalysis } from './analyze.ts';
import type { Schema } from './schema.ts';
import { sqlText, type SqlText } from './text.ts';
import { findQueries } from './tokens.ts';

export const SQL_SYNTAX = 'sql-syntax';
export const SQL_UNKNOWN_TABLE = 'sql-unknown-table';
export const SQL_UNKNOWN_COLUMN = 'sql-unknown-column';

const AFTER_COMMA = new Set(['FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT']);

type Positions = (index: number) => { line: number; character: number };

function positionsOf(text: string): Positions {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: index - starts[lo] };
  };
}

function diagnostic(sql: SqlText, at: Positions, start: number, end: number, code: string, message: string): Diagnostic {
  const from = sql.source[start];
  const to = sql.source[Math.max(start, end - 1)] + 1;
  return { range: { start: at(from), end: at(to) }, code, severity: DiagnosticSeverity.Warning, message, source: 'PHP Forge' };
}

function syntax(sql: SqlText, complete: boolean, at: Positions, out: Diagnostic[]): void {
  const tokens = lex(sql.text);
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (t.text === ',' && next.kind === 'word' && AFTER_COMMA.has(next.value)) {
      out.push(diagnostic(sql, at, t.start, t.end, SQL_SYNTAX, l10n.t('SQL syntax: comma before {0}', next.value)));
    }
    if (t.kind === 'word' && t.value === 'WHERE' && next.kind === 'word' && (next.value === 'AND' || next.value === 'OR')) {
      out.push(diagnostic(sql, at, next.start, next.end, SQL_SYNTAX, l10n.t('SQL syntax: {0} right after WHERE', next.value)));
    }
  }
  if (!complete) return;
  // Requête entière : parenthèses et guillemets équilibrés
  let depth = 0;
  for (const t of tokens) {
    if (t.text === '(') depth++;
    if (t.text === ')' && --depth < 0) {
      out.push(diagnostic(sql, at, t.start, t.end, SQL_SYNTAX, l10n.t('SQL syntax: unexpected )')));
      return;
    }
  }
  if (depth > 0) {
    const open = tokens.filter((t) => t.text === '(').at(-depth)!;
    out.push(diagnostic(sql, at, open.start, open.end, SQL_SYNTAX, l10n.t('SQL syntax: ( is never closed')));
  }
  const last = tokens[tokens.length - 1];
  if (last?.kind === 'string' && (last.text.length < 2 || last.text[last.text.length - 1] !== last.text[0])) {
    out.push(diagnostic(sql, at, last.start, last.start + 1, SQL_SYNTAX, l10n.t('SQL syntax: string never closed')));
  }
}

function names(sql: SqlText, analysis: SqlAnalysis, schema: Schema, created: Set<string>, at: Positions, out: Diagnostic[]): void {
  const byAlias = new Map<string, string>();
  for (const table of analysis.tables) {
    byAlias.set(table.name.toLowerCase(), table.name);
    if (table.alias) byAlias.set(table.alias.toLowerCase(), table.name);
    if (schema.fromDatabase && !schema.table(table.name) && !created.has(table.name.toLowerCase()) && !analysis.ctes.has(table.name.toLowerCase())) {
      out.push(diagnostic(sql, at, table.start, table.end, SQL_UNKNOWN_TABLE, l10n.t('Unknown table {0}', table.name)));
    }
  }
  const allKnown = analysis.tables.length > 0 && !analysis.hasHoles && analysis.tables.every((t) => schema.table(t.name)?.complete);
  for (const column of analysis.columns) {
    const tables = column.qualifier ? [byAlias.get(column.qualifier.toLowerCase())].filter((t): t is string => !!t) : allKnown ? analysis.tables.map((t) => t.name) : [];
    if (!tables.length || !tables.every((t) => schema.table(t)?.complete)) continue;
    if (tables.some((t) => schema.column(t, column.name))) continue;
    const owner = column.qualifier ? tables[0] : tables.join(', ');
    out.push(diagnostic(sql, at, column.start, column.end, SQL_UNKNOWN_COLUMN, l10n.t('Unknown column {0} in {1}', column.name, owner)));
  }
}

export function sqlDiagnostics(tree: Tree, text: string, schema: Schema | undefined): Diagnostic[] {
  const out: Diagnostic[] = [];
  const at = positionsOf(text);
  const queries = findQueries(tree).map((query) => ({ query, sql: sqlText(query) }));
  // Tables créées par les requêtes du fichier (tables temporaires)
  const created = new Set<string>();
  for (const { sql } of queries) for (const m of sql.text.matchAll(/\bCREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)/gi)) created.add(m[1].toLowerCase());
  for (const { query, sql } of queries) {
    syntax(sql, query.complete, at, out);
    if (schema?.loaded) names(sql, analyzeSql(sql.text), schema, created, at, out);
  }
  return out;
}
