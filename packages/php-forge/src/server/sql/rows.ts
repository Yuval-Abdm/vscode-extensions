// Lignes d'un résultat de requête : `$row = mysqli_fetch_assoc($res)`, `$res->fetch_assoc()`,
// `$stmt->fetch(PDO::FETCH_ASSOC)`, `fetchAll()` reçoivent un tableau dont les clés sont les colonnes du SELECT de la
// requête qui a produit `$res` (requête écrite dans l'appel ou dans une variable). Les valeurs sont des chaînes
// (ou null) : c'est ce que rendent mysqli et PDO sans conversion de types.
import type { TypeExpr } from '../../shared/types.ts';
import type { Node } from '../parser/parser.ts';
import { definitionAt } from '../types/flow.ts';
import type { Inferrer } from '../types/infer.ts';
import { analyzeSql } from './analyze.ts';
import { sqlText } from './text.ts';
import { findQueries } from './tokens.ts';

/** Fonctions qui lisent une ligne (true) ou toutes les lignes (false) du résultat passé en premier argument. */
const FETCH_FUNCTIONS: Record<string, boolean> = {
  mysqli_fetch_assoc: true, mysqli_fetch_array: true, mysql_fetch_assoc: true, mysql_fetch_array: true,
  pg_fetch_assoc: true, mysqli_fetch_all: false, pg_fetch_all: false,
};
const FETCH_METHODS: Record<string, boolean> = { fetch_assoc: true, fetch_array: true, fetch: true, fetchall: false, fetch_all: false };
const QUERY_FUNCTION = /(?:^|_)(?:query|prepare)$/i;
const LINK_FIRST = /^(?:mysqli_(?:query|prepare|real_query)|pg_(?:query|prepare))$/i;
const VALUE: TypeExpr = { kind: 'union', types: [{ kind: 'scalar', name: 'string' }, { kind: 'scalar', name: 'null' }] };

const args = (call: Node) => (call.childForFieldName('arguments')?.namedChildren ?? []).filter((a) => a.type === 'argument').map((a) => a.namedChildren[0]);

/** Expression affectée en dernier à la variable avant `at` (même portée). */
function assigned(inf: Inferrer, variable: Node): Node | undefined {
  const anchor = definitionAt(inf, variable.text.slice(1), variable)?.anchor;
  return anchor?.type === 'assignment_expression' ? (anchor.childForFieldName('right') ?? undefined) : undefined;
}

/** Requête SQL d'un appel `mysqli_query($db, $sql)`, `$pdo->query(…)`, `$pdo->prepare(…)`, `rp_query(…)`. */
function queryOf(inf: Inferrer, call: Node): Node | undefined {
  const name = call.type === 'function_call_expression' ? call.childForFieldName('function') : call.childForFieldName('name');
  if (!name || !QUERY_FUNCTION.test(name.text)) return undefined;
  let sql: Node | undefined = args(call)[call.type === 'function_call_expression' && LINK_FIRST.test(name.text) ? 1 : 0];
  if (sql?.type === 'variable_name') sql = assigned(inf, sql);
  return sql;
}

/** Type de la ligne (ou de la liste de lignes) lue par `call`, si la requête est connue. */
export function rowShape(inf: Inferrer, call: Node): TypeExpr | undefined {
  let source: Node | undefined;
  let single: boolean | undefined;
  if (call.type === 'function_call_expression') {
    single = FETCH_FUNCTIONS[call.childForFieldName('function')?.text.toLowerCase() ?? ''];
    source = args(call)[0];
  } else if (call.type === 'member_call_expression') {
    const method = call.childForFieldName('name')?.text.toLowerCase() ?? '';
    single = FETCH_METHODS[method];
    // PDO : mode associatif seulement (par défaut, FETCH_ASSOC ou FETCH_BOTH)
    const mode = args(call)[0]?.text ?? '';
    if ((method === 'fetch' || method === 'fetchall') && mode && !/FETCH_(ASSOC|BOTH)/.test(mode)) return undefined;
    source = call.childForFieldName('object') ?? undefined;
  }
  if (single === undefined || source?.type !== 'variable_name') return undefined;
  const result = assigned(inf, source);
  const queryCall = result?.type === 'function_call_expression' || result?.type === 'member_call_expression' ? result : undefined;
  const sql = queryCall && queryOf(inf, queryCall);
  if (!sql) return undefined;
  const query = findQueries(sql.tree).find((q) => q.root.id === sql.id);
  const select = query && analyzeSql(sqlText(query).text).select;
  if (!select?.length) return undefined;
  const shape: Record<string, TypeExpr> = {};
  for (const item of select) shape[item.key] = VALUE;
  const row: TypeExpr = { kind: 'array', shape };
  return single ? row : { kind: 'array', list: true, value: row };
}
