// Analyse SQL tolérante (MySQL / MariaDB) : jetons, tables et alias, colonnes citées, colonnes du SELECT, contexte
// au curseur. Pas d'arbre complet : la requête peut être un morceau (`$sql .= ' AND …'`) ou contenir des trous
// (parties calculées en PHP) ; ce qui n'est pas compris est ignoré, jamais signalé.
import { FUNCTIONS, KEYWORDS } from './tokens.ts';

export type SqlTokenKind = 'word' | 'quoted' | 'string' | 'number' | 'punct' | 'hole';

export interface Lexeme {
  kind: SqlTokenKind;
  text: string;
  /** Nom sans backquotes pour `quoted`, en majuscules pour un mot-clé */
  value: string;
  start: number;
  end: number;
}

export function lex(text: string): Lexeme[] {
  const out: Lexeme[] = [];
  let i = 0;
  const push = (kind: SqlTokenKind, start: number, end: number, value = text.slice(start, end)) => out.push({ kind, text: text.slice(start, end), value, start, end });
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // Commentaires : -- , # et /* */
    if ((c === '-' && text[i + 1] === '-' && /\s|$/.test(text[i + 2] ?? '')) || c === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    const start = i;
    if (c === '?' && /^\?\d+\?/.test(text.slice(i))) {
      i = text.indexOf('?', i + 1) + 1;
      push('hole', start, i);
      continue;
    }
    // Nombres hexadécimaux et binaires : 0x1F, x'1F', b'0101'
    const literal = /^(?:0x[0-9a-f]+|0b[01]+|[xb]'[0-9a-f]*')/i.exec(text.slice(i, i + 64))?.[0];
    if (literal) {
      i += literal.length;
      push('number', start, i);
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      while (i < text.length) {
        if (text[i] === '\\') i += 2;
        else if (text[i] === c && text[i + 1] === c) i += 2;
        else if (text[i] === c) break;
        else i++;
      }
      i = Math.min(i + 1, text.length);
      push('string', start, i);
      continue;
    }
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      i = end < 0 ? text.length : end + 1;
      push('quoted', start, i, text.slice(start + 1, end < 0 ? text.length : end));
      continue;
    }
    if (/\d/.test(c)) {
      while (i < text.length && /[\d.]/.test(text[i])) i++;
      push('number', start, i);
      continue;
    }
    if (/[A-Za-z_$@\u0080-￿]/.test(c)) {
      while (i < text.length && /[\w$@\u0080-￿]/.test(text[i])) i++;
      push('word', start, i, text.slice(start, i).toUpperCase());
      continue;
    }
    i++;
    push('punct', start, i);
  }
  return out;
}

export interface TableRef {
  /** Nom de la table (sans base ni backquotes) */
  name: string;
  alias?: string;
  start: number;
  end: number;
}

export interface ColumnRef {
  /** Table ou alias écrit devant (`c.nom`) */
  qualifier?: string;
  name: string;
  start: number;
  end: number;
}

export interface SelectItem {
  /** Clé du résultat (alias, nom de colonne, ou texte de l'expression) */
  key: string;
  /** Colonne lue telle quelle */
  column?: { qualifier?: string; name: string };
}

export interface SqlAnalysis {
  tables: TableRef[];
  columns: ColumnRef[];
  /** Colonnes du SELECT ; undefined : pas un SELECT, `*`, ou partie calculée dans la liste */
  select?: SelectItem[];
  /** Alias définis dans le SELECT (`AS total`) : utilisables dans ORDER BY / HAVING */
  selectAliases: Set<string>;
  hasHoles: boolean;
  /** Tables nommées par WITH (CTE) : n'existent que dans la requête */
  ctes: Set<string>;
}

const TABLE_INTRO = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'STRAIGHT_JOIN']);
const CLAUSES = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'SET', 'VALUES', 'VALUE', 'ON', 'USING', 'UNION', 'INTO', 'JOIN', 'UPDATE', 'DELETE', 'INSERT', 'REPLACE', 'DUPLICATE', 'BY', 'OFFSET', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'NATURAL', 'WITH', 'FOR', 'LOCK']);
/** Unités d'INTERVAL et d'EXTRACT */
const UNITS = ['MICROSECOND', 'SECOND', 'MINUTE', 'HOUR', 'DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR', 'SECOND_MICROSECOND', 'MINUTE_MICROSECOND', 'MINUTE_SECOND', 'HOUR_MICROSECOND', 'HOUR_SECOND', 'HOUR_MINUTE', 'DAY_MICROSECOND', 'DAY_SECOND', 'DAY_MINUTE', 'DAY_HOUR', 'YEAR_MONTH'];
const NOT_COLUMNS = new Set([
  ...KEYWORDS, ...UNITS, 'VALUE', 'NULL', 'TRUE', 'FALSE', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME', 'SEPARATOR', 'SIGNED', 'UNSIGNED', 'CHAR', 'INT', 'INTEGER', 'DECIMAL', 'DATETIME',
  'KEY', 'BOOLEAN', 'MODE', 'NATURAL', 'LANGUAGE', 'QUERY', 'EXPANSION', 'LEADING', 'TRAILING', 'BOTH',
]);
/** Clauses où un mot nu est une colonne */
const COLUMN_CLAUSES = new Set(['SELECT', 'WHERE', 'ON', 'SET', 'GROUP', 'ORDER', 'HAVING', 'BY', 'COLUMNS']);

/** Nom de table ou de colonne (pas un mot-clé, pas une variable `@x`) */
const isName = (t: Lexeme | undefined) => !!t && (t.kind === 'quoted' || (t.kind === 'word' && !KEYWORDS.has(t.value) && !t.text.startsWith('@')));

/**
 * Parenthèses d'appel de fonction (`EXTRACT(YEAR FROM d)`, `TRIM(LEADING '0' FROM x)`) : un FROM n'y ouvre pas de
 * liste de tables. Une sous-requête `(SELECT …)` n'en est pas une.
 */
function functionParens(tokens: Lexeme[]): Set<number> {
  const out = new Set<number>();
  tokens.forEach((t, i) => {
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if (t.text === '(' && prev?.kind === 'word' && !(next?.kind === 'word' && (next.value === 'SELECT' || next.value === 'WITH'))) out.add(i);
  });
  return out;
}

/** Profondeur dans des parenthèses d'appel, pour chaque jeton. */
function inCall(tokens: Lexeme[]): boolean[] {
  const calls = functionParens(tokens);
  const stack: boolean[] = [];
  return tokens.map((t, i) => {
    if (t.text === '(') stack.push(calls.has(i));
    const inside = stack.includes(true);
    if (t.text === ')') stack.pop();
    return inside;
  });
}

/** `UPDATE` de `ON DUPLICATE KEY UPDATE` : liste de colonnes, pas une table. */
const duplicateUpdate = (tokens: Lexeme[], i: number) => tokens[i].value === 'UPDATE' && tokens[i - 1]?.kind === 'word' && tokens[i - 1].value === 'KEY';
const nameOf = (t: Lexeme) => (t.kind === 'quoted' ? t.value : t.text);

export function analyzeSql(text: string): SqlAnalysis {
  const tokens = lex(text);
  const tables: TableRef[] = [];
  const columns: ColumnRef[] = [];
  const aliases = new Set<string>();
  const selectAliases = new Set<string>();
  const hasHoles = tokens.some((t) => t.kind === 'hole');
  const calls = inCall(tokens);
  // WITH a AS (…), b AS (…)
  const ctes = new Set<string>();
  tokens.forEach((t, i) => {
    const before = tokens[i - 1];
    if (isName(t) && tokens[i + 1]?.value === 'AS' && tokens[i + 2]?.text === '(' && before && (before.value === 'WITH' || before.value === 'RECURSIVE' || (before.text === ',' && ctes.size))) ctes.add(nameOf(t).toLowerCase());
  });

  // 1. Tables : après FROM / JOIN / UPDATE / INTO, et listes `FROM a, b`
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'word' || !TABLE_INTRO.has(t.value) || calls[i] || duplicateUpdate(tokens, i)) continue;
    // DELETE t FROM … / INSERT INTO t (…) : la table suit directement
    let j = i + 1;
    for (;;) {
      let name = tokens[j];
      if (!isName(name)) break;
      let end = name.end;
      let start = name.start;
      // base.table
      if (tokens[j + 1]?.text === '.' && isName(tokens[j + 2])) {
        name = tokens[j + 2];
        end = name.end;
        start = name.start;
        j += 2;
      }
      const ref: TableRef = { name: nameOf(name), start, end };
      j++;
      if (tokens[j]?.kind === 'word' && tokens[j].value === 'AS') j++;
      if (isName(tokens[j]) && !(tokens[j + 1]?.text === '(')) {
        ref.alias = nameOf(tokens[j]);
        aliases.add(ref.alias.toLowerCase());
        j++;
      }
      tables.push(ref);
      if (t.value !== 'FROM' || tokens[j]?.text !== ',') break;
      j++;
    }
  }

  // 2. Colonnes : `q.col`, et mots nus dans les clauses de colonnes (hors fonctions, alias, VALUES)
  let clause = '';
  let depth = 0;
  let valuesDepth = -1;
  let insertColumns = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if (t.text === '(') {
      depth++;
      // INSERT INTO t (a, b) : liste de colonnes
      if (prev && tables.some((r) => r.end === prev.end) && (clause === 'INTO' || clause === 'REPLACE')) insertColumns = true;
      continue;
    }
    if (t.text === ')') {
      if (depth === valuesDepth) valuesDepth = -1;
      depth--;
      insertColumns = false;
      continue;
    }
    if (t.kind === 'word' && CLAUSES.has(t.value) && !(next?.text === '(' && FUNCTIONS.has(t.value)) && !calls[i]) {
      // ON DUPLICATE KEY UPDATE a = … : colonnes de la table de l'INSERT
      clause = duplicateUpdate(tokens, i) ? 'SET' : t.value;
      if (t.value === 'VALUES' || t.value === 'VALUE') valuesDepth = depth + 1;
      continue;
    }
    if (!isName(t) || prev?.text === '.' || tables.some((r) => r.start === t.start)) continue;
    // COLLATE utf8_bin, CHARACTER SET utf8
    if (prev?.kind === 'word' && (prev.value === 'COLLATE' || prev.value === 'SET' && tokens[i - 2]?.value === 'CHARACTER')) continue;
    if (ctes.has(nameOf(t).toLowerCase()) && next?.value === 'AS') continue;
    if (next?.text === '.' && isName(tokens[i + 2])) {
      // q.col (q : alias ou table)
      columns.push({ qualifier: nameOf(t), name: nameOf(tokens[i + 2]), start: tokens[i + 2].start, end: tokens[i + 2].end });
      continue;
    }
    if (next?.text === '(' && t.kind === 'word') continue;
    if (prev?.kind === 'word' && prev.value === 'AS') {
      if (clause === 'SELECT') selectAliases.add(nameOf(t).toLowerCase());
      continue;
    }
    if (valuesDepth >= 0 && depth >= valuesDepth) continue;
    if (aliases.has(nameOf(t).toLowerCase()) || NOT_COLUMNS.has(t.value)) continue;
    if (!(COLUMN_CLAUSES.has(clause) || insertColumns)) continue;
    // Alias sans AS dans le SELECT : `expr nom,` — le second mot n'est pas une colonne
    if (clause === 'SELECT' && prev && (isName(prev) || prev.text === ')' || prev.kind === 'number' || prev.kind === 'string') && (next?.text === ',' || (next?.kind === 'word' && next.value === 'FROM'))) {
      selectAliases.add(nameOf(t).toLowerCase());
      continue;
    }
    columns.push({ name: nameOf(t), start: t.start, end: t.end });
  }
  // ORDER BY / HAVING peuvent citer un alias du SELECT
  const filtered = columns.filter((c) => c.qualifier || !selectAliases.has(c.name.toLowerCase()));
  return { tables, columns: filtered, select: selectList(tokens, text), selectAliases, hasHoles, ctes };
}

/** Colonnes du premier SELECT (niveau 0), jusqu'au FROM. */
function selectList(tokens: Lexeme[], text: string): SelectItem[] | undefined {
  const first = tokens[0];
  if (first?.kind !== 'word' || first.value !== 'SELECT') return undefined;
  let i = 1;
  while (tokens[i]?.kind === 'word' && ['DISTINCT', 'ALL', 'SQL_CALC_FOUND_ROWS', 'HIGH_PRIORITY', 'STRAIGHT_JOIN'].includes(tokens[i].value)) i++;
  const items: Lexeme[][] = [[]];
  let depth = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (depth === 0 && t.kind === 'word' && t.value === 'FROM') break;
    if (t.text === '(') depth++;
    if (t.text === ')') depth--;
    if (depth === 0 && t.text === ',') items.push([]);
    else items[items.length - 1].push(t);
  }
  const out: SelectItem[] = [];
  for (const item of items) {
    if (!item.length || item.some((t) => t.kind === 'hole')) return undefined;
    const last = item[item.length - 1];
    if (last.text === '*') return undefined;
    // expr AS alias, expr alias
    if (item.length >= 2 && isName(last) && (item[item.length - 2].kind === 'word' && item[item.length - 2].value === 'AS' || item.length >= 2 && item[item.length - 2].text !== '.')) {
      const simple = item.length === 2 || (item.length === 3 && item[1].kind === 'word' && item[1].value === 'AS');
      if (!(item.length === 3 && item[1].text === '.')) {
        out.push({ key: nameOf(last), ...(simple && isName(item[0]) ? { column: { name: nameOf(item[0]) } } : {}) });
        continue;
      }
    }
    if (item.length === 1 && isName(item[0])) {
      out.push({ key: nameOf(item[0]), column: { name: nameOf(item[0]) } });
      continue;
    }
    if (item.length === 3 && isName(item[0]) && item[1].text === '.' && isName(item[2])) {
      out.push({ key: nameOf(item[2]), column: { qualifier: nameOf(item[0]), name: nameOf(item[2]) } });
      continue;
    }
    // Expression sans alias : MySQL prend son texte comme clé
    out.push({ key: text.slice(item[0].start, last.end) });
  }
  return out;
}

export type SqlContext = { kind: 'table' } | { kind: 'column'; qualifier?: string } | { kind: 'none' };

/** Ce que le curseur peut recevoir à `offset` : une table, une colonne (d'un alias), ou rien. */
export function contextAt(text: string, offset: number): SqlContext {
  const tokens = lex(text.slice(0, offset));
  let last = tokens[tokens.length - 1];
  // Mot en cours de frappe
  if (last && (last.kind === 'word' || last.kind === 'quoted') && last.end === offset) {
    tokens.pop();
    last = tokens[tokens.length - 1];
  }
  // Dans une chaîne SQL : rien
  if (last?.kind === 'string' && (last.end === offset && (last.text.length < 2 || last.text[last.text.length - 1] !== last.text[0]))) return { kind: 'none' };
  if (last?.text === '.' && isName(tokens[tokens.length - 2])) return { kind: 'column', qualifier: nameOf(tokens[tokens.length - 2]) };
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.kind !== 'word') continue;
    if (TABLE_INTRO.has(t.value)) {
      // Juste après le mot-clé, ou après une virgule d'une liste FROM
      const after = tokens.slice(i + 1);
      if (!after.length || (t.value === 'FROM' && after[after.length - 1].text === ',')) return { kind: 'table' };
      return after.length <= 2 && t.value !== 'FROM' ? { kind: 'none' } : { kind: 'column' };
    }
    if (COLUMN_CLAUSES.has(t.value)) return { kind: 'column' };
    if (t.value === 'VALUES' || t.value === 'VALUE' || t.value === 'LIMIT') return { kind: 'none' };
  }
  return { kind: 'none' };
}
