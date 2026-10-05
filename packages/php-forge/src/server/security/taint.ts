// Analyse de propagation (§5.7) : données de la requête (superglobales, `extract($_POST)`, `php://input`) suivies
// d'affectation en affectation jusqu'aux points sensibles (SQL, sortie HTML, commandes, inclusion, unserialize,
// redirection, écriture de fichier). Chaque portée (fichier, fonction, méthode, closure) est parcourue dans l'ordre du
// code ; les branches sont réunies, les boucles parcourues deux fois. Une fonction du projet appelée avec une donnée
// de la requête est résumée (paramètres qui atteignent un point sensible ou la valeur renvoyée), à profondeur bornée.
// Les fonctions inconnues rendent une valeur propre : peu de fausses alertes plutôt que l'exhaustivité.
import type { TypeExpr } from '../../shared/types.ts';
import type { Node, Tree } from '../parser/parser.ts';

export type SinkKind = 'sql' | 'xss' | 'command' | 'include' | 'unserialize' | 'redirect' | 'path';

export const SINK_CODES: Record<SinkKind, string> = {
  sql: 'security-sql-injection',
  xss: 'security-xss',
  command: 'security-command-injection',
  include: 'security-file-inclusion',
  unserialize: 'security-unsafe-unserialize',
  redirect: 'security-open-redirect',
  path: 'security-path-traversal',
};

/** Étape du chemin de propagation : source, variable, appel, point sensible. */
export interface Step {
  label: string;
  line: number;
  /** Fichier de l'étape quand elle est dans une fonction d'un autre fichier */
  uri?: string;
}

/** Donnée venue de la requête, et points sensibles pour lesquels elle a été neutralisée. */
interface Taint {
  steps: Step[];
  safe: ReadonlySet<SinkKind>;
  /** Échappée pour le SQL (`mysqli_real_escape_string`) : sûre seulement entre quotes */
  quoted?: boolean;
  /** Résumé d'une fonction : paramètre d'origine */
  param?: number;
}

export interface Finding {
  kind: SinkKind;
  /** Nœud signalé (argument du point sensible, ou appel d'une fonction qui l'atteint) */
  node: Node;
  steps: Step[];
}

/** Résumé d'une fonction : paramètres qui atteignent un point sensible, ou la valeur renvoyée. */
export interface Summary {
  sinks: { param: number; kind: SinkKind; steps: Step[]; safe: ReadonlySet<SinkKind> }[];
  returns: { param: number; steps: Step[]; safe: ReadonlySet<SinkKind>; quoted?: boolean }[];
}

/**
 * Résumés des fonctions d'autres fichiers, partagés entre les fichiers analysés (le serveur les garde tant que le fichier
 * qui déclare la fonction ne change pas). `depth` : profondeur restante quand le résumé a été calculé.
 */
export interface SummaryStore {
  get(name: string, depth: number): Summary | undefined;
  set(name: string, depth: number, summary: Summary): void;
}

export interface FunctionSource {
  uri: string;
  node: Node;
  release(): void;
}

export interface TaintEnv {
  uri: string;
  /** Fonction du projet déclarée dans un autre fichier */
  loadFunction?(name: string): FunctionSource | undefined;
  /** Variable du niveau fichier venue de la requête par un `extract($_POST)` d'un fichier qui inclut celui-ci */
  request?(name: string, at: { line: number; character: number }): { from: string; line: number } | undefined;
  /** Un fichier qui inclut celui-ci a fait `extract($_POST)` : le niveau fichier peut recevoir la requête */
  requestAtEntry?(): boolean;
  /** Fonction du projet d'un autre fichier dont le fichier lit la requête (identifiants de l'index : `_get`, `_post`…) */
  readsRequest?(name: string): boolean;
  /** Fonction native connue (stubs) : true si elle rend une chaîne ou un tableau (donnée transmise), false sinon */
  native?(name: string): boolean | undefined;
  /** Neutraliseurs personnalisés (`phpForge.security.sanitizers`), en minuscules : fonctions ou `classe::méthode` */
  sanitizers?: string[];
  /** Profondeur des résumés (appels imbriqués) */
  depth?: number;
  /** Résumés partagés des fonctions d'autres fichiers */
  summaries?: SummaryStore;
}

const ALL: SinkKind[] = ['sql', 'xss', 'command', 'include', 'unserialize', 'redirect', 'path'];
const SUPERGLOBALS = new Set(['$_GET', '$_POST', '$_REQUEST', '$_COOKIE', '$_FILES', '$_SERVER']);
/** Clés de $_SERVER que le client contrôle */
const SERVER_KEYS = /^(?:HTTP_\w+|REQUEST_URI|QUERY_STRING|PHP_SELF|PATH_INFO|PATH_TRANSLATED|ORIG_PATH_INFO|SCRIPT_NAME|REDIRECT_URL|REDIRECT_QUERY_STRING|AUTH_USER|PHP_AUTH_USER|PHP_AUTH_PW)$/;
/** Clés de $_FILES[…] que le client contrôle (tmp_name, size, error viennent du serveur) */
const FILE_KEYS = new Set(['name', 'type', 'full_path']);

/** Fonctions qui rendent une valeur sans danger pour tous les points sensibles (nombre, booléen, empreinte…) */
const CLEAN = new Set(`
  intval floatval doubleval boolval settype count sizeof strlen mb_strlen is_numeric is_int is_integer is_float is_string
  is_bool is_array is_null isset empty filter_var filter_input filter_var_array filter_input_array md5 sha1 hash crc32
  password_hash password_verify uniqid rand mt_rand random_int round floor ceil abs max min number_format array_key_exists
  in_array array_search ctype_digit ctype_alpha ctype_alnum ctype_xdigit checkdate strtotime mktime gettype strcmp
  strcasecmp strncmp strpos stripos strrpos substr_count preg_match preg_match_all levenshtein similar_text version_compare
`.split(/\s+/).filter(Boolean));
/** Neutraliseurs propres à un point sensible */
const SANITIZERS: Record<string, SinkKind[]> = {
  htmlspecialchars: ['xss'],
  htmlentities: ['xss'],
  urlencode: ['xss', 'redirect', 'command', 'path', 'include'],
  rawurlencode: ['xss', 'redirect', 'command', 'path', 'include'],
  http_build_query: ['xss', 'redirect'],
  escapeshellarg: ['command'],
  escapeshellcmd: ['command'],
  basename: ['path', 'include'],
};
/** Échappement SQL : sûr seulement entre quotes */
const SQL_ESCAPES = new Set(['mysqli_real_escape_string', 'mysql_real_escape_string', 'mysql_escape_string', 'addslashes', 'pg_escape_string', 'pg_escape_literal', 'sqlite_escape_string', 'mysqli_escape_string']);
const SQL_ESCAPE_METHODS = new Set(['real_escape_string', 'escape_string']);
/** Fonctions natives qui transmettent la donnée (la valeur rendue contient les arguments) */
const PASSTHROUGH = new Set(`
  trim ltrim rtrim chop substr mb_substr strtolower strtoupper mb_strtolower mb_strtoupper ucfirst ucwords lcfirst
  str_replace str_ireplace preg_replace substr_replace sprintf vsprintf implode join explode str_pad nl2br urldecode
  rawurldecode base64_decode base64_encode stripslashes stripcslashes html_entity_decode htmlspecialchars_decode
  utf8_encode utf8_decode iconv mb_convert_encoding str_repeat strrev wordwrap array_values array_merge array_filter
  array_unique array_slice array_reverse array_keys current reset end next array_pop array_shift json_decode
  json_encode serialize unserialize strval var_export print_r strstr stristr strrchr strtok str_split chunk_split
  quotemeta addcslashes array_map array_combine array_flip array_fill_keys strip_tags strtr array_column preg_split
  array_pad mb_strimwidth mb_substr_replace array_splice array_chunk array_diff array_intersect array_replace
  array_merge_recursive mb_str_split preg_replace_callback
`.split(/\s+/).filter(Boolean));

/** Requêtes : fonctions et index de l'argument requête */
const QUERY_FUNCTIONS: Record<string, number | 'last'> = {
  mysql_query: 0, mysql_unbuffered_query: 0, mysql_db_query: 1, mysqli_query: 1, mysqli_multi_query: 1, mysqli_real_query: 1,
  mysqli_prepare: 1, pg_query: 'last', pg_send_query: 1, pg_prepare: 2, sqlite_query: 'last', odbc_exec: 1, odbc_prepare: 1,
};
const QUERY_METHODS = new Set(['query', 'multi_query', 'real_query', 'exec', 'prepare', 'unbuffered_query', 'execute_query']);
const COMMANDS = new Set(['exec', 'system', 'shell_exec', 'passthru', 'proc_open', 'popen', 'pcntl_exec']);
const OUTPUT_FUNCTIONS = new Set(['printf', 'vprintf']);
/** Écriture de fichier : index du chemin */
const FILE_WRITES: Record<string, number> = { file_put_contents: 0, move_uploaded_file: 1, copy: 1, rename: 1, unlink: 0, rmdir: 0, mkdir: 0, touch: 0 };
const INCLUDES = new Set(['include_expression', 'include_once_expression', 'require_expression', 'require_once_expression']);
const SCOPES = new Set(['function_definition', 'method_declaration', 'anonymous_function', 'class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration']);
const NUMERIC_CASTS = /^(?:int|integer|float|double|real|bool|boolean|unset)$/i;
const NUMERIC_OPERATORS = new Set(['+', '-', '*', '/', '%', '**', '==', '!=', '<>', '===', '!==', '<', '>', '<=', '>=', '<=>', '&&', '||', 'and', 'or', 'xor', 'instanceof', '&', '|', '^', '<<', '>>']);
/** Gardes qui n'acceptent que des valeurs sûres : `in_array($x, [...], true)`, `is_numeric($x)`, `ctype_digit($x)` */
const GUARDS = new Set(['is_numeric', 'is_int', 'is_integer', 'is_float', 'ctype_digit', 'ctype_alnum', 'ctype_alpha', 'ctype_xdigit']);

const MAX_DEPTH = 3;
/** Résumé : valeur rendue venue directement de la requête (pas d'un paramètre) */
const DIRECT = -1;
/** Texte d'une portée qui peut contenir une source : sinon elle n'est pas parcourue (coût des nœuds tree-sitter) */
const SOURCE_TEXT = /\$_(?:GET|POST|REQUEST|COOKIE|FILES|SERVER)\b|\bextract\s*\(|php:\/\/input/i;

/** Réunion : neutralisations communes ; chemin de la donnée la moins neutralisée (la première à égalité). */
function union(...taints: (Taint | undefined)[]): Taint | undefined {
  const present = taints.filter((t): t is Taint => !!t);
  if (present.length <= 1) return present[0];
  const safe = new Set(ALL.filter((k) => present.every((t) => t.safe.has(k))));
  const weight = (t: Taint) => t.safe.size + (t.quoted ? 1 : 0);
  const worst = present.reduce((a, b) => (weight(b) < weight(a) ? b : a));
  return { ...worst, safe, quoted: present.every((t) => t.quoted) || undefined };
}

function sanitized(taint: Taint | undefined, kinds: SinkKind[]): Taint | undefined {
  if (!taint) return undefined;
  if (kinds.length === ALL.length) return undefined;
  return { ...taint, safe: new Set([...taint.safe, ...kinds]) };
}

function step(taint: Taint | undefined, label: string, line: number, uri?: string): Taint | undefined {
  if (!taint) return undefined;
  const last = taint.steps[taint.steps.length - 1];
  if (last && last.label === label && last.uri === uri) return taint;
  return { ...taint, steps: [...taint.steps, { label, line, ...(uri ? { uri } : {}) }] };
}

const lower = (node: Node | null | undefined) => (node?.text ?? '').replace(/^\\/, '').toLowerCase();

/** État d'une portée : variables et leur donnée (undefined : propre). */
class State {
  vars = new Map<string, Taint | undefined>();
  /** `extract($_POST)` : toute variable non affectée vient de la requête */
  extracted?: Step;

  clone(): State {
    const copy = new State();
    copy.vars = new Map(this.vars);
    copy.extracted = this.extracted;
    return copy;
  }

  /** Réunion de deux chemins d'exécution */
  merge(other: State): void {
    for (const [name, taint] of other.vars) this.vars.set(name, union(this.vars.get(name), taint));
    this.extracted ??= other.extracted;
  }
}

/** Déclarations d'un fichier : fonctions par nom, méthodes par « classe::nom » (minuscules). */
interface Declarations {
  functions: Map<string, Node>;
  methods: Map<string, Node>;
  /** Toutes les fonctions et méthodes, dans l'ordre du fichier */
  all: Node[];
}

class Analyzer {
  readonly findings: Finding[] = [];
  readonly #reported = new Set<string>();
  readonly #summaries: Map<string, Summary | null>;
  readonly #env: TaintEnv;
  readonly #uri: string;
  readonly #declarations: Declarations;
  readonly #depth: number;
  /** Résumé en cours : paramètres suivis, points sensibles et valeurs renvoyées */
  readonly #summary?: Summary;
  #state = new State();
  #main = false;
  readonly #requests = new Map<string, { from: string; line: number } | undefined>();
  #className?: string;

  constructor(env: TaintEnv, uri: string, declarations: Declarations, summaries: Map<string, Summary | null>, depth: number, summary?: Summary) {
    this.#env = env;
    this.#uri = uri;
    this.#declarations = declarations;
    this.#summaries = summaries;
    this.#depth = depth;
    this.#summary = summary;
  }

  /** Niveau fichier : les fonctions et classes sont analysées à part. */
  runMain(root: Node): void {
    this.#main = true;
    this.#statements(root.namedChildren);
  }

  /** Corps d'une fonction ; `tainted` : paramètres suivis (résumé), sinon paramètres propres. */
  runFunction(fn: Node, tainted: boolean, initial?: State): void {
    this.#state = initial ?? new State();
    this.#className = enclosingClass(fn);
    const params = fn.childForFieldName('parameters')?.namedChildren.filter((p) => p.type.endsWith('parameter')) ?? [];
    params.forEach((param, index) => {
      const name = param.childForFieldName('name')?.text;
      if (!name) return;
      this.#state.vars.set(name, tainted ? { steps: [{ label: name, line: param.startPosition.row }], safe: new Set(), param: index } : undefined);
    });
    const body = fn.childForFieldName('body');
    if (!body) return;
    if (body.type === 'compound_statement') this.#statements(body.namedChildren);
    else this.#return(this.#eval(body));
  }

  #statements(nodes: Node[]): void {
    for (const node of nodes) this.#statement(node);
  }

  #statement(node: Node): void {
    switch (node.type) {
      case 'function_definition':
      case 'method_declaration':
      case 'class_declaration':
      case 'interface_declaration':
      case 'trait_declaration':
      case 'enum_declaration':
      case 'comment':
      case 'text':
      case 'php_tag':
      case 'php_end_tag':
        return;
      case 'text_interpolation':
        return;
      case 'compound_statement':
      case 'declaration_list':
      case 'colon_block':
        return this.#statements(node.namedChildren);
      case 'expression_statement': {
        const value = this.#eval(node.namedChildren[0]);
        // <?= $x ?>
        if (isShortEcho(node)) this.#sink('xss', node.namedChildren[0], value);
        return;
      }
      case 'echo_statement':
        for (const expr of echoed(node)) this.#sink('xss', expr, this.#eval(expr));
        return;
      case 'return_statement': {
        const expr = node.namedChildren[0];
        if (expr) this.#return(this.#eval(expr));
        return;
      }
      case 'exit_statement': {
        const arg = node.namedChildren[0];
        if (arg) this.#sink('xss', arg, this.#eval(arg));
        return;
      }
      case 'global_declaration':
      case 'static_variable_declaration':
        for (const v of node.descendantsOfType('variable_name')) this.#state.vars.set(v.text, undefined);
        return;
      case 'unset_statement':
        for (const v of node.namedChildren) if (v.type === 'variable_name') this.#state.vars.set(v.text, undefined);
        return;
      case 'if_statement':
        return this.#if(node);
      case 'while_statement':
      case 'do_statement':
      case 'for_statement':
        return this.#loop(() => {
          for (const child of node.namedChildren) {
            if (child.type === 'compound_statement' || child.type === 'colon_block' || isStatement(child)) this.#statement(child);
            else this.#eval(child);
          }
        });
      case 'foreach_statement':
        return this.#foreach(node);
      case 'switch_statement': {
        this.#eval(node.childForFieldName('condition'));
        const before = this.#state;
        const after = before.clone();
        for (const branch of node.childForFieldName('body')?.namedChildren ?? []) {
          this.#state = before.clone();
          this.#statements(branch.namedChildren.filter((c) => c.type !== 'comment' && c !== branch.childForFieldName('value')));
          after.merge(this.#state);
        }
        this.#state = after;
        return;
      }
      case 'try_statement': {
        const before = this.#state.clone();
        for (const child of node.namedChildren) {
          if (child.type === 'compound_statement') this.#statements(child.namedChildren);
          else {
            const saved = this.#state;
            this.#state = before.clone();
            this.#statements(child.childForFieldName('body')?.namedChildren ?? []);
            saved.merge(this.#state);
            this.#state = saved;
          }
        }
        return;
      }
      default:
        if (isStatement(node)) {
          for (const child of node.namedChildren) this.#statement(child);
          return;
        }
        this.#eval(node);
    }
  }

  #if(node: Node): void {
    const condition = node.childForFieldName('condition');
    this.#eval(condition);
    const guard = guards(condition);
    const before = this.#state;
    // Branche « alors » : la variable gardée est sûre ; garde niée (« if (!is_numeric($x)) exit; ») : sûre après
    this.#state = before.clone();
    for (const name of guard.positive) this.#state.vars.set(name, undefined);
    const body = node.childForFieldName('body');
    if (body) this.#statement(body);
    const branches = [this.#state];
    const exits = !!body && leaves(body);
    let exhaustive = false;
    for (const alt of node.namedChildren.filter((c) => c.type === 'else_if_clause' || c.type === 'else_clause')) {
      this.#state = before.clone();
      if (alt.type === 'else_if_clause') {
        this.#eval(alt.childForFieldName('condition'));
      } else {
        exhaustive = true;
        for (const name of guard.negated) this.#state.vars.set(name, undefined);
      }
      const altBody = alt.childForFieldName('body');
      if (altBody) this.#statement(altBody);
      branches.push(this.#state);
    }
    const after = exhaustive ? branches[0].clone() : before.clone();
    if (!exhaustive && exits) for (const name of guard.negated) after.vars.set(name, undefined);
    for (const b of exhaustive ? branches.slice(1) : branches) {
      if (b === branches[0] && exits) continue;
      after.merge(b);
    }
    this.#state = after;
  }

  /**
   * Corps exécuté zéro, une ou plusieurs fois, réuni avec l'état d'avant. Second passage seulement si le premier a
   * rendu une variable porteuse (propagation d'un tour au suivant) : sinon il ne changerait rien, et des boucles
   * imbriquées seraient parcourues 2^n fois.
   */
  #loop(body: () => void): void {
    const before = this.#state.clone();
    const tainted = (state: State) => [...state.vars].filter(([, t]) => t).map(([name]) => name);
    const known = new Set(tainted(before));
    body();
    if (tainted(this.#state).some((name) => !known.has(name))) body();
    this.#state.merge(before);
  }

  #foreach(node: Node): void {
    const children = node.namedChildren;
    const iterated = this.#eval(children[0]);
    const target = children[1];
    const body = node.childForFieldName('body');
    this.#loop(() => {
      const line = node.startPosition.row;
      if (target?.type === 'pair') {
        for (const v of target.namedChildren) this.#assign(v, iterated, line);
      } else if (target) {
        this.#assign(target, iterated, line);
      }
      if (body) this.#statement(body);
    });
  }

  /** Résumé : valeur rendue qui vient d'un paramètre, ou directement de la requête (`DIRECT`, fonction « getter ») */
  #return(taint: Taint | undefined): void {
    if (!this.#summary || !taint) return;
    const param = taint.param ?? DIRECT;
    if (this.#summary.returns.some((r) => r.param === param)) return;
    this.#summary.returns.push({ param, steps: taint.steps, safe: taint.safe, quoted: taint.quoted });
  }

  #read(name: string, node: Node): Taint | undefined {
    if (this.#state.vars.has(name)) return this.#state.vars.get(name);
    if (SUPERGLOBALS.has(name)) return { steps: [{ label: name, line: node.startPosition.row }], safe: new Set() };
    if (name === '$this' || name === '$GLOBALS') return undefined;
    if (this.#state.extracted) return { steps: [this.#state.extracted, { label: name, line: node.startPosition.row }], safe: new Set() };
    if (this.#main && this.#env.request) {
      // Une question au moteur d'inclusion par variable (sa réponse vaut pour tout le niveau fichier)
      if (!this.#requests.has(name)) this.#requests.set(name, this.#env.request(name, { line: node.startPosition.row, character: node.startPosition.column }));
      const from = this.#requests.get(name);
      if (from) return { steps: [{ label: `extract(${from.from})`, line: from.line }, { label: name, line: node.startPosition.row }], safe: new Set() };
    }
    return undefined;
  }

  #assign(left: Node | null, value: Taint | undefined, line: number): void {
    if (!left) return;
    switch (left.type) {
      case 'variable_name':
        this.#state.vars.set(left.text, step(value, left.text, line));
        return;
      case 'subscript_expression': {
        // $a['x'] = … : le tableau contient la donnée
        let base: Node | null = left;
        while (base?.type === 'subscript_expression') base = base.namedChildren[0];
        if (base?.type === 'variable_name' && value) this.#state.vars.set(base.text, union(this.#state.vars.get(base.text), step(value, base.text, line)));
        return;
      }
      case 'list_literal':
      case 'array_creation_expression':
        for (const v of left.descendantsOfType('variable_name')) this.#state.vars.set(v.text, step(value, v.text, line));
        return;
      default:
        this.#eval(left);
    }
  }

  /** Valeur d'une expression ; les affectations, appels et points sensibles qu'elle contient sont traités. */
  #eval(node: Node | null | undefined): Taint | undefined {
    if (!node) return undefined;
    switch (node.type) {
      case 'variable_name':
        return this.#read(node.text, node);
      case 'subscript_expression':
        return this.#subscript(node);
      case 'member_access_expression':
      case 'nullsafe_member_access_expression':
        return this.#eval(node.childForFieldName('object'));
      case 'parenthesized_expression':
      case 'error_suppression_expression':
        return this.#eval(node.namedChildren[0]);
      case 'match_expression': {
        this.#eval(node.childForFieldName('condition'));
        const arms = node.childForFieldName('body')?.namedChildren ?? [];
        return union(...arms.map((arm) => this.#eval(arm.childForFieldName('return_expression'))));
      }
      case 'encapsed_string':
      case 'heredoc':
      case 'shell_command_expression': {
        const value = this.#concat(stringParts(node));
        if (node.type === 'shell_command_expression') this.#sink('command', node, value);
        return value;
      }
      case 'string':
      case 'nowdoc':
      case 'integer':
      case 'float':
      case 'boolean':
      case 'null':
        return undefined;
      case 'binary_expression': {
        const operator = node.childForFieldName('operator')?.type ?? '';
        if (operator === '.') return this.#concat(flattenConcat(node));
        const left = this.#eval(node.childForFieldName('left'));
        const right = this.#eval(node.childForFieldName('right'));
        return NUMERIC_OPERATORS.has(operator) ? undefined : union(left, right);
      }
      case 'unary_op_expression':
        this.#eval(node.namedChildren[0]);
        return undefined;
      case 'update_expression':
        this.#eval(node.namedChildren[0]);
        return undefined;
      case 'conditional_expression': {
        const condition = this.#eval(node.childForFieldName('condition'));
        const body = node.childForFieldName('body');
        return union(body ? this.#eval(body) : condition, this.#eval(node.childForFieldName('alternative')));
      }
      case 'cast_expression': {
        const value = this.#eval(node.childForFieldName('value'));
        return NUMERIC_CASTS.test(node.childForFieldName('type')?.text ?? '') ? undefined : value;
      }
      case 'assignment_expression':
      case 'reference_assignment_expression': {
        const value = this.#eval(node.childForFieldName('right'));
        this.#assign(node.childForFieldName('left'), value, node.startPosition.row);
        return value;
      }
      case 'augmented_assignment_expression': {
        const left = node.childForFieldName('left');
        const operator = node.childForFieldName('operator')?.type ?? '';
        const right = this.#eval(node.childForFieldName('right'));
        const before = this.#eval(left);
        const value = operator === '.=' || operator === '??=' ? union(before, right) : undefined;
        this.#assign(left, value, node.startPosition.row);
        return value;
      }
      case 'array_creation_expression':
        return union(...node.namedChildren.map((element) => union(...element.namedChildren.map((c) => this.#eval(c)))));
      case 'function_call_expression':
        return this.#call(node);
      case 'member_call_expression':
      case 'nullsafe_member_call_expression':
        return this.#methodCall(node);
      case 'scoped_call_expression':
        return this.#staticCall(node);
      case 'object_creation_expression':
        for (const arg of argumentsOf(node)) this.#eval(arg);
        return undefined;
      case 'print_intrinsic': {
        const value = this.#eval(node.namedChildren[0]);
        this.#sink('xss', node.namedChildren[0], value);
        return undefined;
      }
      case 'exit_statement':
      case 'exit_expression': {
        const arg = node.namedChildren[0];
        if (arg) this.#sink('xss', arg, this.#eval(arg));
        return undefined;
      }
      case 'anonymous_function':
        this.#closure(node);
        return undefined;
      case 'arrow_function':
        return undefined;
      case 'sequence_expression':
        return union(...node.namedChildren.map((c) => this.#eval(c)));
      default:
        if (INCLUDES.has(node.type)) {
          const target = node.namedChildren[0];
          this.#sink('include', target, this.#eval(target));
          return undefined;
        }
        if (SCOPES.has(node.type)) return undefined;
        for (const child of node.namedChildren) this.#eval(child);
        return undefined;
    }
  }

  #subscript(node: Node): Taint | undefined {
    const base = node.namedChildren[0];
    const index = node.namedChildren[1];
    this.#eval(index);
    if (base?.type === 'variable_name' && SUPERGLOBALS.has(base.text)) {
      const key = keyOf(index);
      // Superglobale gardée (« if (!is_numeric($_GET['id'])) die(); ») : propre
      if (key !== undefined && this.#state.vars.has(`${base.text}[${key}]`)) return this.#state.vars.get(`${base.text}[${key}]`);
      if (base.text === '$_SERVER' && !(key && SERVER_KEYS.test(key))) return undefined;
      return { steps: [{ label: node.text.length <= 60 ? node.text : `${base.text}[…]`, line: node.startPosition.row }], safe: new Set() };
    }
    // $_FILES['f']['name'] : seulement les clés que le client choisit
    if (base?.type === 'subscript_expression' && base.namedChildren[0]?.text === '$_FILES') {
      const key = keyOf(index);
      return key && !FILE_KEYS.has(key) ? undefined : { steps: [{ label: node.text, line: node.startPosition.row }], safe: new Set() };
    }
    return this.#eval(base);
  }

  /** Concaténation ou chaîne interpolée : une donnée échappée pour le SQL entre quotes est sûre pour le SQL. */
  #concat(parts: Node[]): Taint | undefined {
    const values = parts.map((p) => (p.type === 'string_content' || p.type === 'escape_sequence' ? undefined : this.#eval(p)));
    // Texte SQL autour de chaque morceau : les valeurs calculées comptent comme du texte sans guillemet
    const texts = parts.map((p, i) => (values[i] || !isLiteral(p) ? 'x' : (literalText(p) ?? 'x')));
    const effective = values.map((value, i) => {
      if (!value?.quoted || value.safe.has('sql')) return value;
      // Dans un littéral SQL ouvert avant (« LIKE '% ») et refermé après (« %' ») : l'échappement protège
      const quote = openQuote(texts.slice(0, i).join(''));
      return quote && texts.slice(i + 1).join('').includes(quote) ? { ...value, safe: new Set([...value.safe, 'sql' as SinkKind]) } : value;
    });
    return union(...effective);
  }

  #args(node: Node): { nodes: Node[]; taints: (Taint | undefined)[] } {
    const nodes = argumentsOf(node);
    return { nodes, taints: nodes.map((n) => this.#eval(n)) };
  }

  #call(node: Node): Taint | undefined {
    const fn = node.childForFieldName('function');
    const name = lower(fn);
    if (fn?.type !== 'name' && fn?.type !== 'qualified_name') {
      this.#eval(fn);
      this.#args(node);
      return undefined;
    }
    const { nodes, taints } = this.#args(node);
    const line = node.startPosition.row;
    // Points sensibles
    const query = QUERY_FUNCTIONS[name];
    if (query !== undefined) {
      const index = query === 'last' ? nodes.length - 1 : query;
      if (nodes[index]) this.#sink('sql', nodes[index], taints[index], name);
      return undefined;
    }
    if (COMMANDS.has(name)) {
      if (nodes[0]) this.#sink('command', nodes[0], taints[0], name);
      return taints[0] && step(taints[0], name, line);
    }
    if (name === 'die' || name === 'exit') {
      if (nodes[0]) this.#sink('xss', nodes[0], taints[0], name);
      return undefined;
    }
    if (OUTPUT_FUNCTIONS.has(name)) {
      nodes.forEach((n, i) => this.#sink('xss', n, taints[i], name));
      return undefined;
    }
    if (name === 'unserialize' && nodes[0]) this.#sink('unserialize', nodes[0], taints[0], name);
    if (name === 'header' && nodes[0] && isLocation(nodes[0])) this.#sink('redirect', nodes[0], taints[0], name);
    if (name in FILE_WRITES) {
      const index = FILE_WRITES[name];
      if (nodes[index]) this.#sink('path', nodes[index], taints[index], name);
    }
    if (name === 'fopen' && nodes[0] && /[waxc+]/.test(literalText(nodes[1]) ?? '')) this.#sink('path', nodes[0], taints[0], name);
    if (name === 'extract' && nodes[0]) {
      const source = taints[0];
      if (source) this.#state.extracted = { label: `extract(${nodes[0].text})`, line };
      return undefined;
    }
    if (name === 'file_get_contents' && /^['"]php:\/\/input['"]$/.test(nodes[0]?.text ?? '')) return { steps: [{ label: 'php://input', line }], safe: new Set() };
    // Valeur rendue
    if (CLEAN.has(name) || this.#env.sanitizers?.includes(name)) return undefined;
    if (name in SANITIZERS) return step(sanitized(taints[0], SANITIZERS[name]), `${name}()`, line);
    if (SQL_ESCAPES.has(name)) {
      const value = taints[name.startsWith('mysqli') || name === 'pg_escape_string' && nodes.length > 1 ? 1 : 0] ?? union(...taints);
      return value && { ...value, quoted: true, steps: [...value.steps, { label: `${name}()`, line }] };
    }
    if (PASSTHROUGH.has(name)) return step(union(...taints), `${name}()`, line);
    // Fonction native des stubs (sans déclaration dans le projet) : transmet la donnée si elle rend une chaîne ou un tableau
    if (!this.#declarations.functions.has(name) && this.#env.native?.(name)) return step(union(...taints), `${name}()`, line);
    return this.#user(name, this.#declarations.functions.get(name), name, nodes, taints, node);
  }

  #methodCall(node: Node): Taint | undefined {
    const object = node.childForFieldName('object');
    this.#eval(object);
    const name = lower(node.childForFieldName('name'));
    const { nodes, taints } = this.#args(node);
    const line = node.startPosition.row;
    if (QUERY_METHODS.has(name)) {
      if (nodes[0]) this.#sink('sql', nodes[0], taints[0], `->${name}`);
      return undefined;
    }
    if (SQL_ESCAPE_METHODS.has(name)) return taints[0] && { ...taints[0], quoted: true, steps: [...taints[0].steps, { label: `->${name}()`, line }] };
    if (name === 'quote') return undefined;
    if (this.#className && this.#env.sanitizers?.includes(`${this.#className.toLowerCase()}::${name}`)) return undefined;
    if (object?.text === '$this') return this.#user(`$this->${name}`, this.#method(name), name, nodes, taints, node, true);
    return undefined;
  }

  #staticCall(node: Node): Taint | undefined {
    const scope = node.childForFieldName('scope');
    const name = lower(node.childForFieldName('name'));
    const { nodes, taints } = this.#args(node);
    const own = scope?.type === 'relative_scope' || (this.#className && scope?.text.toLowerCase() === this.#className.toLowerCase());
    if (this.#env.sanitizers?.includes(`${(scope?.text ?? '').replace(/^\\/, '').toLowerCase()}::${name}`)) return undefined;
    return own ? this.#user(`${scope!.text}::${name}`, this.#method(name), name, nodes, taints, node, true) : undefined;
  }

  /** Méthode de la classe en cours, déclarée dans le fichier (héritage : non suivi) */
  #method(name: string): Node | undefined {
    return this.#className ? this.#declarations.methods.get(`${this.#className.toLowerCase()}::${name}`) : undefined;
  }

  /** Fonction ou méthode du projet : résumé, appliqué aux arguments venus de la requête. */
  #user(label: string, local: Node | undefined, name: string, nodes: Node[], taints: (Taint | undefined)[], call: Node, method = false): Taint | undefined {
    if (this.#depth <= 0 || (method && !local)) return undefined;
    // Sans argument venu de la requête : seulement une fonction qui lit elle-même la requête (getter)
    if (!taints.some((t) => t) && !(local ? SOURCE_TEXT.test(local.text) : this.#env.readsRequest?.(name))) return undefined;
    const summary = this.#summarize(name, local);
    if (!summary) return undefined;
    const line = call.startPosition.row;
    for (const sink of summary.sinks) {
      const arg = taints[sink.param];
      if (!arg) continue;
      const safe = new Set([...arg.safe, ...sink.safe]);
      if (safe.has(sink.kind)) continue;
      // Paramètre propre (le chemin de l'argument), appel, puis le chemin dans la fonction sans son paramètre
      const steps = [...arg.steps, { label: `${label}()`, line }, ...sink.steps.slice(1)];
      this.#report(sink.kind, nodes[sink.param] ?? call, steps, arg);
    }
    const returned = summary.returns.map((r) => {
      if (r.param === DIRECT) return { steps: [...r.steps, { label: `${label}()`, line }], safe: r.safe, quoted: r.quoted };
      const arg = taints[r.param];
      return arg && { steps: [...arg.steps, { label: `${label}()`, line }], safe: new Set([...arg.safe, ...r.safe]), quoted: r.quoted || arg.quoted || undefined };
    });
    return union(...returned);
  }

  /** Fonction d'un autre fichier dont la valeur rendue vient de la requête (getter) */
  returnsRequest(name: string): boolean {
    return !!this.#summarize(name, undefined)?.returns.some((r) => r.param === DIRECT);
  }

  #summarize(name: string, local: Node | undefined): Summary | undefined {
    const key = local ? `${this.#uri}#${local.startIndex}` : `fn:${name}`;
    if (this.#summaries.has(key)) return this.#summaries.get(key) ?? undefined;
    const shared = local ? undefined : this.#env.summaries?.get(name, this.#depth);
    if (shared) {
      this.#summaries.set(key, shared);
      return shared;
    }
    this.#summaries.set(key, null); // récursion
    let source: FunctionSource | undefined;
    const node = local ?? (source = this.#env.loadFunction?.(name))?.node;
    if (!node) return undefined;
    try {
      const uri = source?.uri ?? this.#uri;
      const summary: Summary = { sinks: [], returns: [] };
      const declarations = source ? declarationsOf(node.tree) : this.#declarations;
      const analyzer = new Analyzer(this.#env, uri, declarations, this.#summaries, this.#depth - 1, summary);
      analyzer.runFunction(node, true);
      // Étapes dans un autre fichier : chemin affiché avec le fichier
      if (source) for (const s of [...summary.sinks, ...summary.returns]) s.steps = s.steps.map((st) => ({ ...st, uri: st.uri ?? uri }));
      this.#summaries.set(key, summary);
      if (!local) this.#env.summaries?.set(name, this.#depth, summary);
      return summary;
    } finally {
      source?.release();
    }
  }

  #closure(node: Node): void {
    const initial = new State();
    for (const v of node.descendantsOfType('variable_name').filter((v) => v.parent?.type === 'anonymous_function_use_clause')) initial.vars.set(v.text, this.#state.vars.get(v.text));
    const analyzer = new Analyzer(this.#env, this.#uri, this.#declarations, this.#summaries, this.#depth);
    analyzer.runFunction(node, false, initial);
    for (const finding of analyzer.findings) this.#push(finding);
  }

  #sink(kind: SinkKind, node: Node | undefined | null, taint: Taint | undefined, label?: string): void {
    // Échappée pour le SQL mais hors quotes (« WHERE id = $id ») : l'échappement ne protège pas
    if (!node || !taint || taint.safe.has(kind)) return;
    const steps = [...taint.steps, { label: label ?? sinkLabel(kind), line: node.startPosition.row }];
    this.#report(kind, node, steps, taint);
  }

  #report(kind: SinkKind, node: Node, steps: Step[], taint: Taint): void {
    if (this.#summary) {
      if (taint.param === undefined) return; // source directe : signalée en analysant le fichier lui-même
      this.#summary.sinks.push({ param: taint.param, kind, steps, safe: taint.safe });
      return;
    }
    if (taint.param !== undefined) return;
    this.#push({ kind, node, steps });
  }

  #push(finding: Finding): void {
    const key = `${finding.kind}:${finding.node.startIndex}`;
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    this.findings.push(finding);
  }
}

function sinkLabel(kind: SinkKind): string {
  return { sql: 'SQL', xss: 'echo', command: 'shell', include: 'include', unserialize: 'unserialize', redirect: 'header', path: 'file' }[kind];
}

function enclosingClass(node: Node): string | undefined {
  for (let n = node.parent; n; n = n.parent) {
    if (n.type === 'class_declaration' || n.type === 'trait_declaration' || n.type === 'enum_declaration') return n.childForFieldName('name')?.text;
  }
  return undefined;
}

function isStatement(node: Node): boolean {
  return node.type.endsWith('_statement') || node.type === 'compound_statement' || node.type === 'colon_block';
}

/** Instruction qui suit une balise `<?=` */
function isShortEcho(node: Node): boolean {
  const prev = node.previousSibling;
  if (prev?.type === 'php_tag') return prev.text === '<?=';
  if (prev?.type === 'text_interpolation') return prev.lastChild?.type === 'php_tag' && prev.lastChild.text === '<?=';
  return false;
}

function echoed(node: Node): Node[] {
  const expr = node.namedChildren[0];
  return expr?.type === 'sequence_expression' ? expr.namedChildren : expr ? [expr] : [];
}

function argumentsOf(call: Node): Node[] {
  const args = call.childForFieldName('arguments') ?? call.namedChildren.find((c) => c.type === 'arguments');
  return (args?.namedChildren ?? []).filter((a) => a.type === 'argument').map((a) => a.namedChildren[a.namedChildren.length - 1]!).filter(Boolean);
}

function flattenConcat(node: Node): Node[] {
  if (node.type === 'binary_expression' && node.childForFieldName('operator')?.type === '.') return [...flattenConcat(node.childForFieldName('left')!), ...flattenConcat(node.childForFieldName('right')!)];
  if (node.type === 'parenthesized_expression' && node.namedChildren[0]) return flattenConcat(node.namedChildren[0]);
  return [node];
}

/** Morceaux d'une chaîne interpolée : texte et expressions. */
function stringParts(node: Node): Node[] {
  const holder = node.type === 'heredoc' ? node.namedChildren.find((c) => c.type === 'heredoc_body') ?? node : node;
  return holder.namedChildren.filter((c) => c.type !== 'heredoc_start' && c.type !== 'heredoc_end');
}

function isLiteral(node: Node): boolean {
  return node.type === 'string' || node.type === 'string_content' || node.type === 'escape_sequence' || (node.type === 'encapsed_string' && node.namedChildren.every((c) => c.type === 'string_content' || c.type === 'escape_sequence'));
}

/** Texte d'un littéral (sans ses guillemets) */
function literalText(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'string_content' || node.type === 'escape_sequence') return node.text;
  if (node.type === 'string' || node.type === 'encapsed_string') return node.text.slice(1, -1);
  return undefined;
}

/** Guillemet SQL laissé ouvert à la fin du texte (« \\' » et « '' » ne ferment pas). */
function openQuote(text: string): string | undefined {
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote && text[i + 1] === quote) i++;
      else if (c === quote) quote = undefined;
    } else if (c === "'" || c === '"') quote = c;
  }
  return quote;
}

function keyOf(index: Node | undefined): string | undefined {
  return literalText(index);
}

/** `header('Location: ' . …)` */
function isLocation(arg: Node): boolean {
  const first = arg.type === 'binary_expression' ? flattenConcat(arg)[0] : arg.type === 'encapsed_string' ? arg.namedChildren[0] : undefined;
  return /^\s*location\s*:/i.test(literalText(first) ?? '');
}

/** Garde d'une condition : `is_numeric($x)`, `in_array($x, [...], true)`, éventuellement niée. */
/** Nom suivi par l'état : variable, ou superglobale à clé littérale (« $_GET[id] »). */
function guardKey(node: Node | undefined): string | undefined {
  if (node?.type === 'variable_name') return node.text;
  if (node?.type === 'subscript_expression' && SUPERGLOBALS.has(node.namedChildren[0]?.text ?? '')) {
    const key = keyOf(node.namedChildren[1]);
    return key === undefined ? undefined : `${node.namedChildren[0].text}[${key}]`;
  }
  return undefined;
}

/**
 * Gardes d'une condition : `is_numeric($x)`, `in_array($x, [...], true)` (aussi sur `$_GET['x']`). `positive` : sûres
 * dans la branche « alors » (combinées par &&) ; `negated` : sûres dans le « sinon » et après une branche « alors »
 * qui sort (« if (!isset($x) || !is_numeric($x)) exit; », combinées par ||).
 */
function guards(condition: Node | null | undefined): { positive: string[]; negated: string[] } {
  let node = condition;
  while (node?.type === 'parenthesized_expression') node = node.namedChildren[0];
  if (!node) return { positive: [], negated: [] };
  if (node.type === 'binary_expression') {
    const operator = node.childForFieldName('operator')?.type.toLowerCase();
    const left = guards(node.childForFieldName('left'));
    const right = guards(node.childForFieldName('right'));
    if (operator === '&&' || operator === 'and') return { positive: [...left.positive, ...right.positive], negated: [] };
    if (operator === '||' || operator === 'or') return { positive: [], negated: [...left.negated, ...right.negated] };
    return { positive: [], negated: [] };
  }
  if (node.type === 'unary_op_expression' && node.child(0)?.type === '!') {
    const inner = guards(node.namedChildren[0]);
    return { positive: inner.negated, negated: inner.positive };
  }
  if (node.type !== 'function_call_expression') return { positive: [], negated: [] };
  const name = lower(node.childForFieldName('function'));
  const args = argumentsOf(node);
  const key = guardKey(args[0]);
  if (!key) return { positive: [], negated: [] };
  if (GUARDS.has(name)) return { positive: [key], negated: [] };
  if (name === 'in_array' && args[1]?.type === 'array_creation_expression' && args[2]?.text.toLowerCase() === 'true') {
    const literal = args[1].namedChildren.every((e) => e.namedChildren.every((c) => isLiteral(c) || c.type === 'integer'));
    return literal ? { positive: [key], negated: [] } : { positive: [], negated: [] };
  }
  return { positive: [], negated: [] };
}

/** Bloc qui se termine toujours par exit, die, return ou throw. */
function leaves(body: Node): boolean {
  const last = body.type === 'compound_statement' ? body.namedChildren.filter((c) => c.type !== 'comment').at(-1) : body;
  if (!last) return false;
  if (last.type === 'return_statement' || last.type === 'throw_expression' || last.type === 'exit_statement' || last.type === 'continue_statement' || last.type === 'break_statement') return true;
  const expr = last.type === 'expression_statement' ? last.namedChildren[0] : undefined;
  return !!expr && (expr.type === 'exit_statement' || expr.type === 'exit_expression' || expr.type === 'throw_expression' || (expr.type === 'function_call_expression' && /^(?:die|exit)$/i.test(expr.childForFieldName('function')?.text ?? '')));
}

const declarationCache = new WeakMap<Tree, Declarations>();

function declarationsOf(tree: Tree): Declarations {
  const cached = declarationCache.get(tree);
  if (cached) return cached;
  const declarations = collectDeclarations(tree);
  declarationCache.set(tree, declarations);
  return declarations;
}

function collectDeclarations(tree: Tree): Declarations {
  const functions = new Map<string, Node>();
  const methods = new Map<string, Node>();
  const all = tree.rootNode.descendantsOfType(['function_definition', 'method_declaration']);
  for (const fn of all) {
    const name = fn.childForFieldName('name')?.text.toLowerCase();
    if (!name) continue;
    if (fn.type === 'function_definition') {
      if (!functions.has(name)) functions.set(name, fn);
    } else {
      const owner = enclosingClass(fn)?.toLowerCase();
      if (owner) methods.set(`${owner}::${name}`, fn);
    }
  }
  return { functions, methods, all };
}

/** Identifiants de l'index (minuscules, sans « $ ») d'un fichier qui lit la requête */
export const REQUEST_NAMES = new Set(['_get', '_post', '_request', '_cookie', '_files', '_server', 'extract']);

/** Type rendu par une fonction native qui peut contenir la donnée : chaîne, tableau, mixed (non déclaré). */
export function returnsData(type: TypeExpr | undefined): boolean {
  if (!type) return true;
  switch (type.kind) {
    case 'scalar':
      return type.name === 'string' || type.name === 'scalar' || type.name === 'array-key';
    case 'array':
    case 'mixed':
    case 'template':
      return true;
    case 'union':
    case 'intersection':
      return type.types.some(returnsData);
    default:
      return false;
  }
}

/** Données de la requête qui atteignent un point sensible, dans tout le fichier. */
export function analyzeTaint(tree: Tree, env: TaintEnv): Finding[] {
  const declarations = declarationsOf(tree);
  const summaries = new Map<string, Summary | null>();
  const depth = env.depth ?? MAX_DEPTH;
  const out: Finding[] = [];
  const text = tree.rootNode.text;
  // Fonctions appelées qui lisent elles-mêmes la requête (getters) : leurs appels sont aussi des sources
  const readers = new Set<string>();
  let prober: Analyzer | undefined;
  const probe = () => (prober ??= new Analyzer(env, env.uri, declarations, summaries, depth));
  for (const call of tree.rootNode.descendantsOfType('function_call_expression')) {
    const fn = call.childForFieldName('function');
    if (fn?.type !== 'name' && fn?.type !== 'qualified_name') continue;
    const name = lower(fn);
    if (readers.has(name)) continue;
    const local = declarations.functions.get(name);
    // Autre fichier : le fichier lit la requête (index) et la fonction rend vraiment une donnée de la requête
    if (local ? SOURCE_TEXT.test(local.text) : env.readsRequest?.(name) && probe().returnsRequest(name)) readers.add(name);
  }
  const reads = (scope: string) => SOURCE_TEXT.test(scope) || [...readers].some((name) => scope.toLowerCase().includes(`${name}(`));
  if (reads(text) || (env.requestAtEntry ? env.requestAtEntry() : !!env.request)) {
    const main = new Analyzer(env, env.uri, declarations, summaries, depth);
    main.runMain(tree.rootNode);
    out.push(...main.findings);
  }
  if (!reads(text)) return out;
  for (const fn of declarations.all) {
    if (!reads(fn.text)) continue;
    const analyzer = new Analyzer(env, env.uri, declarations, summaries, depth);
    analyzer.runFunction(fn, false);
    out.push(...analyzer.findings);
  }
  return out;
}
