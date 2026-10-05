// SQL dans les chaînes PHP : détection des requêtes et jetons de coloration (mots-clés, fonctions, nombres).
// Une requête est une chaîne ou une concaténation entière (« 'SELECT …'.$x.' GROUP BY …' ») : la suite est
// colorée même si elle commence sur une autre ligne, ce que la grammaire TextMate de VS Code ne peut pas voir.
// Sont des requêtes : le texte qui commence comme du SQL, les arguments des fonctions de requête
// (`rp_query`, `->query`, `mysqli_query`…) et les ajouts `.=` à une variable qui contient une requête.
import type { Node, Tree } from '../parser/parser.ts';
import { FUNCTION_NODES } from '../model/context.ts';

export interface SqlToken {
  line: number;
  character: number;
  length: number;
  type: 'keyword' | 'function' | 'number';
}

const LITERALS = new Set(['string', 'encapsed_string', 'heredoc', 'nowdoc']);
const QUERY_FUNCTION = /(?:^|_)(?:query|prepare|exec|execute)$/i;
/** Fonctions dont la requête suit la connexion */
const LINK_FIRST = /^(?:mysqli_(?:query|prepare|real_query|multi_query)|pg_(?:query|send_query))$/i;
/** Début en majuscules (comme la grammaire PHP de VS Code), ou structure complète en minuscules (pas « Select a … from … »). */
const SQL_START = /^\s*\(?\s*(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH|CREATE|ALTER|DROP|TRUNCATE|SHOW)\b/;
const SQL_SHAPE = /^\s*\(?\s*(?:select\b[\s\S]*\bfrom\b|insert\s+(?:ignore\s+)?into\b|update\b[\s\S]*\bset\b|delete\s+from\b|replace\s+into\b)/;

export const KEYWORDS = new Set(`
  SELECT FROM WHERE AND OR NOT IN IS NULL LIKE BETWEEN EXISTS AS ON JOIN LEFT RIGHT INNER OUTER CROSS NATURAL STRAIGHT_JOIN
  USING GROUP BY ORDER ASC DESC HAVING LIMIT OFFSET UNION ALL DISTINCT INSERT IGNORE INTO VALUES UPDATE SET DELETE REPLACE
  CREATE TABLE TEMPORARY ALTER DROP TRUNCATE INDEX PRIMARY FOREIGN REFERENCES DEFAULT CASE WHEN THEN ELSE END WITH
  DUPLICATE SHOW TABLES DATABASE VIEW REGEXP RLIKE DIV MOD XOR TRUE FALSE INTERVAL ROLLUP FOR SHARE LOCK ESCAPE COLLATE
  BINARY OVER PARTITION ADD COLUMN MODIFY CHANGE RENAME TO IF
`.split(/\s+/).filter(Boolean));

export const FUNCTIONS = new Set(`
  COUNT SUM AVG MIN MAX GROUP_CONCAT CONCAT CONCAT_WS IFNULL NULLIF COALESCE IF ISNULL NOW CURDATE CURTIME CURRENT_DATE
  CURRENT_TIMESTAMP DATE TIME YEAR MONTH DAY WEEK HOUR MINUTE SECOND DAYOFWEEK DAYOFMONTH WEEKDAY LAST_DAY DATE_FORMAT
  DATE_ADD DATE_SUB ADDDATE SUBDATE DATEDIFF TIMEDIFF TIMESTAMPDIFF STR_TO_DATE UNIX_TIMESTAMP FROM_UNIXTIME LOWER UPPER
  LCASE UCASE TRIM LTRIM RTRIM SUBSTRING SUBSTR SUBSTRING_INDEX LEFT RIGHT LENGTH CHAR_LENGTH REPLACE LOCATE INSTR LPAD RPAD
  FIND_IN_SET FIELD ROUND FLOOR CEIL CEILING ABS MOD RAND CAST CONVERT FORMAT MD5 SHA1 SHA2 UUID JSON_EXTRACT
  JSON_UNQUOTE JSON_OBJECT JSON_ARRAY EXISTS IN VALUES ROW_NUMBER RANK
`.split(/\s+/).filter(Boolean));

export function sqlTokens(tree: Tree): SqlToken[] {
  const out: SqlToken[] = [];
  for (const query of sqlQueries(tree)) tokenize(query, out);
  return out;
}

/** Requête SQL trouvée dans le code PHP. */
export interface SqlQuery {
  /** Chaîne ou concaténation entière */
  root: Node;
  /** Morceaux de la concaténation, dans l'ordre (littéraux et expressions) */
  parts: Node[];
  /** Requête entière : une seule chaîne, ni concaténée ni complétée plus loin par `.=` */
  complete: boolean;
}

const queryCache = new WeakMap<Tree, SqlQuery[]>();

/** Contexte d'une chaîne (ou d'une concaténation) : ses ancêtres utiles, relevés pendant le parcours. */
interface Root {
  node: Node;
  parent?: Node;
  /** Appel dont la chaîne est un argument */
  call?: Node;
  /** Portée (fonction ou fichier) */
  scope: number;
}

const CONTEXT = new Set(['assignment_expression', 'augmented_assignment_expression', 'argument', 'arguments', ...FUNCTION_NODES]);
const CALLS = new Set(['function_call_expression', 'member_call_expression', 'nullsafe_member_call_expression', 'scoped_call_expression']);

/**
 * Requêtes du fichier : pour chacune, ses chaînes littérales dans l'ordre. Un seul parcours descendant :
 * remonter vers les parents est coûteux avec tree-sitter (plusieurs secondes sur un fichier de 7 000 lignes).
 */
export function sqlQueries(tree: Tree): Node[][] {
  return findQueries(tree).map((q) => q.parts.filter((p) => LITERALS.has(p.type)));
}

/** Requêtes du fichier (calculées une fois par arbre). */
export function findQueries(tree: Tree): SqlQuery[] {
  let cached = queryCache.get(tree);
  if (!cached) queryCache.set(tree, (cached = scan(tree)));
  return cached;
}

function scan(tree: Tree): SqlQuery[] {
  const roots: Root[] = [];
  // Ancêtres : nœud gardé seulement pour les types utiles au contexte
  const stack: { type: string; node?: Node }[] = [];
  const cursor = tree.walk();
  for (;;) {
    const type = cursor.nodeType;
    const isRoot = LITERALS.has(type) || (type === 'binary_expression' && cursor.currentNode.childForFieldName('operator')?.type === '.');
    if (isRoot) {
      const top = stack[stack.length - 1];
      const node = cursor.currentNode;
      const scope = [...stack].reverse().find((a) => a.node && FUNCTION_NODES.has(a.type))?.node?.id ?? 0;
      const call = top?.type === 'argument' && CALLS.has(stack[stack.length - 3]?.type ?? '') ? stack[stack.length - 3].node : undefined;
      roots.push({ node, parent: top?.node, call, scope });
    }
    const keep = CONTEXT.has(type) || CALLS.has(type);
    if (!isRoot && cursor.gotoFirstChild()) {
      // Le nœud dont on vient de descendre devient un ancêtre
      stack.push({ type, node: keep ? parentNode(cursor) : undefined });
      continue;
    }
    let done = false;
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent()) {
        done = true;
        break;
      }
      stack.pop();
    }
    if (done) break;
  }
  cursor.delete();

  const queries = new Map<number, { root: Root; parts: Node[] }>();
  const sqlVariables = new Set<string>();
  const appended = new Set<string>();
  const appends: Root[] = [];
  for (const root of roots) {
    const parts = flatten(root.node);
    // Variable reprise dans une concaténation : sa requête n'est pas entière
    if (parts.length > 1) for (const part of parts) if (part.type === 'variable_name') appended.add(`${root.scope}:${part.text}`);
    const target = assignedVariable(root);
    if (target && root.parent?.type === 'augmented_assignment_expression') appended.add(target);
    if (isSql(parts) || isQueryArgument(root)) {
      queries.set(root.node.id, { root, parts });
      if (target) sqlVariables.add(target);
    } else if (root.parent?.type === 'augmented_assignment_expression') {
      appends.push(root);
    }
  }
  for (const root of appends) {
    const target = assignedVariable(root);
    if (target && sqlVariables.has(target)) queries.set(root.node.id, { root, parts: flatten(root.node) });
  }
  // Dans l'ordre du fichier
  return [...queries.values()].sort((a, b) => a.root.node.startIndex - b.root.node.startIndex).map(({ root, parts }) => {
    const target = assignedVariable(root);
    const complete = parts.length === 1 && root.parent?.type !== 'augmented_assignment_expression' && !(target && appended.has(target));
    return { root: root.node, parts, complete };
  });
}

/** Nœud courant du curseur, qui vient de descendre vers son premier enfant : on remonte un instant le relever. */
function parentNode(cursor: ReturnType<Tree['walk']>): Node {
  cursor.gotoParent();
  const node = cursor.currentNode;
  cursor.gotoFirstChild();
  return node;
}

function flatten(node: Node): Node[] {
  if (node.type !== 'binary_expression' || node.childForFieldName('operator')?.type !== '.') return [node];
  return [...flatten(node.childForFieldName('left')!), ...flatten(node.childForFieldName('right')!)];
}

function isSql(parts: Node[]): boolean {
  const text = parts.map((p) => (LITERALS.has(p.type) ? contentOf(p).map((c) => c.text).join('') : ' ? ')).join('');
  return SQL_START.test(text) || SQL_SHAPE.test(text);
}

/** `$var = …` ou `$var .= …` : nom de la variable, propre à sa portée (fonction ou fichier). */
function assignedVariable(root: Root): string | undefined {
  const parent = root.parent;
  if (!parent || (parent.type !== 'assignment_expression' && parent.type !== 'augmented_assignment_expression')) return undefined;
  if (parent.childForFieldName('right')?.id !== root.node.id) return undefined;
  if (parent.type === 'augmented_assignment_expression' && parent.childForFieldName('operator')?.type !== '.=') return undefined;
  const left = parent.childForFieldName('left');
  return left?.type === 'variable_name' ? `${root.scope}:${left.text}` : undefined;
}

/** Argument requête d'une fonction de requête : le premier (`rp_query('…', 'query')`), ou celui qui suit la connexion (`mysqli_query($db, '…')`). */
function isQueryArgument(root: Root): boolean {
  const call = root.call;
  if (!call) return false;
  const name = call.type === 'function_call_expression' ? call.childForFieldName('function') : call.childForFieldName('name');
  if (!name || !QUERY_FUNCTION.test(name.text)) return false;
  const args = (call.childForFieldName('arguments')?.namedChildren ?? []).filter((a) => a.type === 'argument');
  const query = args[call.type === 'function_call_expression' && LINK_FIRST.test(name.text) ? 1 : 0];
  return query?.namedChildren.some((c) => c.id === root.node.id) ?? false;
}

/** Morceaux de texte d'une chaîne (hors guillemets et interpolations). */
export function contentOf(literal: Node): Node[] {
  const holder = literal.type === 'heredoc' || literal.type === 'nowdoc' ? literal.namedChildren.find((c) => c.type.endsWith('_body')) : literal;
  return (holder?.namedChildren ?? []).filter((c) => c.type === 'string_content' || c.type === 'escape_sequence');
}

/** Parcours du texte de la requête : guillemets SQL suivis d'une chaîne à l'autre de la concaténation. */
function tokenize(literals: Node[], out: SqlToken[]): void {
  let quote: string | undefined;
  for (const literal of literals) {
    for (const piece of contentOf(literal)) {
      if (piece.type === 'escape_sequence') {
        const char = piece.text.slice(1);
        if (char === "'" || char === '"' || char === '`') quote = quote === char ? undefined : (quote ?? char);
        continue;
      }
      const text = piece.text;
      let line = piece.startPosition.row;
      let column = piece.startPosition.column;
      for (let i = 0; i < text.length; ) {
        const c = text[i];
        if (c === '\n') {
          line++;
          column = 0;
          i++;
          continue;
        }
        if (quote) {
          if (c === '\\') {
            i += 2;
            column += 2;
            continue;
          }
          if (c === quote) quote = undefined;
          i++;
          column++;
          continue;
        }
        if (c === "'" || c === '"' || c === '`') {
          quote = c;
          i++;
          column++;
          continue;
        }
        const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, i + 64))?.[0];
        if (word) {
          const qualified = text[i - 1] === '.' || text[i + word.length] === '.';
          if (!qualified) {
            const upper = word.toUpperCase();
            const call = /^\s*\(/.test(text.slice(i + word.length, i + word.length + 16));
            const type = call && FUNCTIONS.has(upper) ? 'function' : KEYWORDS.has(upper) ? 'keyword' : undefined;
            if (type) out.push({ line, character: column, length: word.length, type });
          }
          i += word.length;
          column += word.length;
          continue;
        }
        const number = /^\d+(?:\.\d+)?/.exec(text.slice(i, i + 32))?.[0];
        if (number) {
          out.push({ line, character: column, length: number.length, type: 'number' });
          i += number.length;
          column += number.length;
          continue;
        }
        i++;
        column++;
      }
    }
  }
}
