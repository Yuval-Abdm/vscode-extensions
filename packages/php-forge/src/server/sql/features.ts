// SQL sous le curseur : complétion des tables, des colonnes (selon les alias du FROM) et des fonctions SQL,
// survol d'une table ou d'une colonne (type, NULL, défaut), aller à la définition (CREATE TABLE d'un fichier .sql).
import * as l10n from '@vscode/l10n';
import type { Tree } from '../parser/parser.ts';
import { analyzeSql, contextAt, lex, type Lexeme, type SqlAnalysis } from './analyze.ts';
import type { Schema, SqlColumn, SqlTable } from './schema.ts';
import { sqlOffset, sqlText, type SqlText } from './text.ts';
import { findQueries, FUNCTIONS } from './tokens.ts';

export interface SqlSite {
  sql: SqlText;
  /** Position du curseur dans le texte SQL */
  offset: number;
}

/** Requête SQL qui contient l'index `index` du document. */
export function sqlAt(tree: Tree, index: number): SqlSite | undefined {
  for (const query of findQueries(tree)) {
    if (index < query.root.startIndex || index > query.root.endIndex) continue;
    const sql = sqlText(query);
    const offset = sqlOffset(sql, index);
    if (offset !== undefined) return { sql, offset };
  }
  return undefined;
}

export interface SqlCompletionItem {
  label: string;
  kind: 'table' | 'column' | 'function';
  detail?: string;
}

export interface SqlCompletion {
  items: SqlCompletionItem[];
  /** Index du document où commence le mot à remplacer */
  from: number;
}

/** Tables de la requête par nom et par alias. */
function tablesByName(analysis: SqlAnalysis): Map<string, string> {
  const out = new Map<string, string>();
  for (const table of analysis.tables) {
    out.set(table.name.toLowerCase(), table.name);
    if (table.alias) out.set(table.alias.toLowerCase(), table.name);
  }
  return out;
}

const columnDetail = (table: SqlTable, column: SqlColumn) => `${table.name} · ${column.type}${column.nullable ? '' : ' NOT NULL'}`;

export function sqlCompletion(site: SqlSite, schema: Schema): SqlCompletion | undefined {
  const { sql, offset } = site;
  const word = /[\w$]*$/.exec(sql.text.slice(0, offset))![0];
  const from = sql.source[offset - word.length] ?? sql.source[offset];
  const context = contextAt(sql.text, offset);
  if (context.kind === 'none') return undefined;
  if (context.kind === 'table') {
    return { from, items: schema.tables.map((t) => ({ label: t.name, kind: 'table' as const, detail: l10n.t('{0} columns', t.columns.length) })) };
  }
  const analysis = analyzeSql(sql.text);
  const byName = tablesByName(analysis);
  const items: SqlCompletionItem[] = [];
  const add = (name: string) => {
    const table = schema.table(name);
    for (const column of table?.columns ?? []) items.push({ label: column.name, kind: 'column', detail: columnDetail(table!, column) });
  };
  if (context.qualifier) {
    const table = byName.get(context.qualifier.toLowerCase());
    if (table) add(table);
    return { from, items };
  }
  for (const table of new Set(analysis.tables.map((t) => t.name))) add(table);
  for (const fn of FUNCTIONS) items.push({ label: fn, kind: 'function' });
  return { from, items };
}

/** Jeton sous le curseur (ou qui finit au curseur). */
function lexemeAt(tokens: Lexeme[], offset: number): number {
  return tokens.findIndex((t) => t.start <= offset && offset <= t.end && (t.kind === 'word' || t.kind === 'quoted'));
}

export type SqlTarget = { table: SqlTable; column?: SqlColumn };

/** Table ou colonne désignée au curseur. */
export function sqlTarget(site: SqlSite, schema: Schema): SqlTarget | undefined {
  const tokens = lex(site.sql.text);
  const i = lexemeAt(tokens, site.offset);
  if (i < 0) return undefined;
  const t = tokens[i];
  const name = t.kind === 'quoted' ? t.value : t.text;
  const analysis = analyzeSql(site.sql.text);
  const byName = tablesByName(analysis);
  // Table : dans la liste des tables de la requête
  if (analysis.tables.some((r) => r.start === t.start)) {
    const table = schema.table(name);
    return table && { table };
  }
  // Colonne qualifiée : q.col
  if (tokens[i - 1]?.text === '.' && tokens[i - 2]) {
    const q = tokens[i - 2];
    const table = schema.table(byName.get((q.kind === 'quoted' ? q.value : q.text).toLowerCase()) ?? '');
    const column = table && schema.column(table.name, name);
    return column ? { table: table!, column } : undefined;
  }
  // Alias ou table devant un point : la table
  if (tokens[i + 1]?.text === '.') {
    const table = schema.table(byName.get(name.toLowerCase()) ?? '');
    return table && { table };
  }
  for (const ref of analysis.tables) {
    const column = schema.column(ref.name, name);
    if (column) return { table: schema.table(ref.name)!, column };
  }
  return undefined;
}

export function sqlHover(target: SqlTarget): string {
  const { table, column } = target;
  if (column) {
    const nullability = column.nullable ? 'NULL' : 'NOT NULL';
    const def = column.default !== undefined ? ` · DEFAULT ${column.default}` : '';
    return `\`${table.name}.${column.name}\` — \`${column.type}\` · ${nullability}${def}`;
  }
  const columns = table.columns.slice(0, 30).map((c) => `- \`${c.name}\` ${c.type}${c.nullable ? '' : ' NOT NULL'}`).join('\n');
  const more = table.columns.length > 30 ? `\n- … (${table.columns.length - 30})` : '';
  return `**${table.name}** (${l10n.t('{0} columns', table.columns.length)})\n\n${columns}${more}`;
}
