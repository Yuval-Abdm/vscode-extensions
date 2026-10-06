// Schéma de la base : tables et colonnes lues dans les fichiers .sql du projet (`CREATE TABLE`, `ALTER TABLE … ADD`)
// ou dans le cache d'une connexion à la base (`.vscode/php-forge-schema.json`, commande « Refresh SQL schema »).
// Un fichier .sql qui supprime une table (`DROP TABLE`) ne la retire pas : les scripts de migration recréent souvent
// ce qu'ils suppriment.
import { lex, type Lexeme } from './analyze.ts';

export interface SqlColumn {
  name: string;
  /** Type écrit (`varchar(100)`, `int(11) unsigned`) */
  type: string;
  nullable: boolean;
  default?: string;
}

export interface SqlTable {
  name: string;
  columns: SqlColumn[];
  /** Toutes ses colonnes sont connues (CREATE TABLE, base) ; sinon seulement celles d'un ALTER TABLE … ADD */
  complete: boolean;
  /** Déclaration (fichier .sql) : document et position du nom */
  uri?: string;
  line?: number;
  character?: number;
}

/** Contenu de `.vscode/php-forge-schema.json`. */
export interface SchemaCache {
  database: string;
  refreshed: string;
  tables: { name: string; columns: SqlColumn[] }[];
}

const CONSTRAINTS = new Set(['PRIMARY', 'KEY', 'INDEX', 'UNIQUE', 'CONSTRAINT', 'FOREIGN', 'FULLTEXT', 'SPATIAL', 'CHECK', 'PERIOD']);

/** Position (ligne, colonne) d'un index du texte : débuts de ligne calculés une fois, recherche dichotomique. */
function positions(text: string): (index: number) => { line: number; character: number } {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
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

/** Fin d'une instruction : premier `;` hors chaîne, commentaire et parenthèses (ou fin du texte). */
function statementEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\' && c !== '`') i++;
    } else if ((c === '-' && text[i + 1] === '-') || c === '#') {
      const end = text.indexOf('\n', i);
      if (end < 0) return text.length;
      i = end;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return text.length;
      i = end + 1;
    } else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ';' && depth <= 0) return i;
  }
  return text.length;
}

/** Début d'instruction qui déclare ou complète une table */
const TABLE_STATEMENT = /\b(?:CREATE\s+(?:(?:TEMPORARY|OR\s+REPLACE)\s+)*TABLE|ALTER\s+(?:IGNORE\s+)?TABLE)\b/gi;

const nameOf = (t: Lexeme) => (t.kind === 'quoted' ? t.value : t.text);

/** Morceaux de premier niveau d'une liste entre parenthèses commençant au jeton `open`. */
function items(tokens: Lexeme[], open: number): { items: Lexeme[][]; end: number } {
  const out: Lexeme[][] = [[]];
  let depth = 0;
  let i = open;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.text === '(') {
      depth++;
      if (depth === 1) continue;
    }
    if (t.text === ')') {
      depth--;
      if (depth === 0) break;
    }
    if (depth === 1 && t.text === ',') out.push([]);
    else out[out.length - 1].push(t);
  }
  return { items: out.filter((item) => item.length), end: i };
}

/** Colonne d'une définition `nom type(…) [NOT NULL] [DEFAULT x] …`. */
function column(item: Lexeme[], text: string): SqlColumn | undefined {
  const [name, type] = item;
  if (!name || !(name.kind === 'word' || name.kind === 'quoted') || !type || CONSTRAINTS.has(name.value)) return undefined;
  // Type : le mot, ses parenthèses et ses attributs (unsigned, zerofill)
  let end = 1;
  if (item[2]?.text === '(') {
    let depth = 0;
    for (end = 2; end < item.length; end++) {
      if (item[end].text === '(') depth++;
      if (item[end].text === ')' && --depth === 0) break;
    }
  }
  while (item[end + 1]?.kind === 'word' && ['UNSIGNED', 'SIGNED', 'ZEROFILL'].includes(item[end + 1].value)) end++;
  const typeText = text.slice(type.start, item[end].end).replace(/\s+/g, ' ');
  const words = item.map((t) => t.value);
  const notNull = words.some((w, i) => w === 'NOT' && words[i + 1] === 'NULL') || words.includes('PRIMARY');
  const at = words.indexOf('DEFAULT');
  const def = at >= 0 && item[at + 1] ? item[at + 1].text : undefined;
  return { name: nameOf(name), type: typeText, nullable: !notNull, ...(def !== undefined ? { default: def } : {}) };
}

/**
 * Tables d'un fichier .sql. Seules les instructions CREATE TABLE / ALTER TABLE sont analysées : un dump est surtout
 * fait d'INSERT, jamais lus.
 */
export function parseSqlFile(text: string, uri: string): SqlTable[] {
  const out: SqlTable[] = [];
  let at: ReturnType<typeof positions> | undefined;
  let done = 0;
  for (const match of text.matchAll(TABLE_STATEMENT)) {
    const start = match.index;
    if (start < done) continue;
    // Ligne commentée (-- ou #)
    const line = text.slice(text.lastIndexOf('\n', start - 1) + 1, start);
    if (/^\s*(?:--|#)/.test(line)) continue;
    done = statementEnd(text, start);
    const tokens = lex(text.slice(start, done)).map((t) => ({ ...t, start: t.start + start, end: t.end + start }));
    tablesOf(tokens, text, uri, (index) => (at ??= positions(text))(index), out);
  }
  return out;
}

function tablesOf(tokens: Lexeme[], text: string, uri: string, lineAt: (index: number) => { line: number; character: number }, out: SqlTable[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'word') continue;
    if (t.value === 'CREATE') {
      let j = i + 1;
      while (tokens[j]?.kind === 'word' && ['TEMPORARY', 'OR', 'REPLACE'].includes(tokens[j].value)) j++;
      if (tokens[j]?.value !== 'TABLE') continue;
      j++;
      if (tokens[j]?.value === 'IF' && tokens[j + 1]?.value === 'NOT' && tokens[j + 2]?.value === 'EXISTS') j += 3;
      let name = tokens[j];
      if (tokens[j + 1]?.text === '.' && tokens[j + 2]) name = tokens[(j += 2)];
      if (!name || tokens[j + 1]?.text !== '(') continue;
      const list = items(tokens, j + 1);
      const columns = list.items.map((item) => column(item, text)).filter((c): c is SqlColumn => !!c);
      out.push({ name: nameOf(name), columns, complete: true, uri, ...lineAt(name.start) });
      i = list.end;
    } else if (t.value === 'ALTER' && tokens[i + 1]?.value === 'TABLE') {
      // ALTER TABLE t ADD [COLUMN] c type, ADD …
      let j = i + 2;
      let name = tokens[j];
      if (tokens[j + 1]?.text === '.' && tokens[j + 2]) name = tokens[(j += 2)];
      if (!name) continue;
      const added: SqlColumn[] = [];
      for (let k = j + 1; k < tokens.length && tokens[k].text !== ';'; k++) {
        if (tokens[k].value !== 'ADD') continue;
        let start = k + 1;
        if (tokens[start]?.value === 'COLUMN') start++;
        const item: Lexeme[] = [];
        let depth = 0;
        for (let m = start; m < tokens.length; m++) {
          const x = tokens[m];
          if (x.text === '(') depth++;
          if (x.text === ')') depth--;
          if (depth === 0 && (x.text === ',' || x.text === ';')) break;
          item.push(x);
        }
        const c = column(item, text);
        if (c) added.push(c);
      }
      if (added.length) out.push({ name: nameOf(name), columns: added, complete: false });
    }
  }
}

export class Schema {
  readonly #tables = new Map<string, SqlTable>();
  /** Liste des tables venue de la base : une table absente n'existe pas */
  #fromDatabase = false;

  get fromDatabase(): boolean {
    return this.#fromDatabase;
  }

  get loaded(): boolean {
    return this.#tables.size > 0;
  }

  get tables(): SqlTable[] {
    return [...this.#tables.values()];
  }

  table(name: string): SqlTable | undefined {
    return this.#tables.get(name.toLowerCase());
  }

  /** Ajoute (ou complète) des tables : les colonnes d'un ALTER TABLE s'ajoutent à la table existante. */
  add(tables: SqlTable[]): void {
    for (const table of tables) {
      const key = table.name.toLowerCase();
      const existing = this.#tables.get(key);
      if (!existing) {
        this.#tables.set(key, { ...table, columns: [...table.columns] });
        continue;
      }
      for (const c of table.columns) if (!existing.columns.some((e) => e.name.toLowerCase() === c.name.toLowerCase())) existing.columns.push(c);
      // Position de la déclaration : celle du CREATE TABLE plutôt que celle d'un ALTER TABLE lu avant
      if (table.uri && (!existing.uri || (table.complete && !existing.complete))) Object.assign(existing, { uri: table.uri, line: table.line, character: table.character });
      existing.complete ||= table.complete;
    }
  }

  addCache(cache: SchemaCache, uri: string): void {
    const column = (c: SqlColumn) => typeof c?.name === 'string' && typeof c.type === 'string' && typeof c.nullable === 'boolean' && (c.default === undefined || typeof c.default === 'string');
    const valid = Array.isArray(cache?.tables) && cache.tables.every((t) => typeof t?.name === 'string' && Array.isArray(t.columns) && t.columns.every(column));
    if (!valid) throw new Error('not a PHP Forge schema cache');
    this.add(cache.tables.map((t) => ({ ...t, complete: true, uri })));
    this.#fromDatabase = true;
  }

  clear(): void {
    this.#tables.clear();
    this.#fromDatabase = false;
  }

  column(table: string, name: string): SqlColumn | undefined {
    return this.table(table)?.columns.find((c) => c.name.toLowerCase() === name.toLowerCase());
  }
}
