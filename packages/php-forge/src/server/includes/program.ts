// Programme des variables par portée (§4.4) : suite ordonnée d'opérations sérialisables — affectations, lectures,
// inclusions, unset, extract, appels avec des variables nues (paramètres par référence), symboles utilisés,
// sorties — avec les branches et les boucles. Exécuté symboliquement par l'analyse des inclusions.
import type { FileFlow, FlowArg, FlowFunction, FlowOp, IncludeKind, IncludeRef, Loc, NameScope } from '../../shared/types.ts';
import { resolveClassName, resolveFunctionOrConstant, scopeAt } from '../model/names.ts';
import { cleanDoc, docVar } from '../model/phpdoc.ts';
import { rangeOf } from '../model/ranges.ts';
import { squash } from '../model/signature.ts';
import type { Node } from '../parser/parser.ts';
import { parseDocType } from '../types/docType.ts';
import type { Inferrer } from '../types/infer.ts';
import { includeHint, pathExprOf } from './pathExpr.ts';

/** Toujours définies : superglobales, $this, variables de la ligne de commande et de PHP. */
export const ALWAYS_DEFINED = new Set([
  'this', 'GLOBALS', '_SERVER', '_GET', '_POST', '_FILES', '_COOKIE', '_SESSION', '_REQUEST', '_ENV',
  'argv', 'argc', 'http_response_header', 'php_errormsg',
]);

const REQUEST = new Set(['$_GET', '$_POST', '$_REQUEST', '$_COOKIE']);
const INCLUDE_KINDS: Record<string, IncludeKind> = {
  include_expression: 'include',
  include_once_expression: 'include_once',
  require_expression: 'require',
  require_once_expression: 'require_once',
};
const NAME_TYPES = new Set(['name', 'qualified_name', 'relative_name']);
const CLASS_NODES = new Set(['class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration']);
const SELF = new Set(['self', 'static', 'parent']);
const NOT_CONSTANTS = new Set(['true', 'false', 'null', '__dir__', '__file__', '__line__', '__function__', '__class__', '__method__', '__namespace__', '__trait__']);
/** Nœuds dont un enfant `name` est une constante utilisée */
const CONSTANT_PARENTS = new Set([
  'echo_statement', 'return_statement', 'expression_statement', 'array_element_initializer', 'parenthesized_expression',
  'subscript_expression', 'unary_op_expression', 'sequence_expression', 'argument', 'conditional_expression',
  'binary_expression', 'assignment_expression', 'augmented_assignment_expression', 'cast_expression', 'clone_expression',
  'yield_expression', 'exit_statement', 'print_intrinsic', 'match_condition_list', 'match_conditional_expression',
  'match_default_expression', 'pair',
]);
const SHORT_CIRCUIT = new Set(['&&', '||', 'and', 'or']);
const TERMINATORS = new Set(['break_statement', 'continue_statement', 'return_statement', 'exit_statement']);
/** Au-delà, le type d'une affectation n'est pas gardé (taille du cache) */
const MAX_TYPE = 500;

type Assign = Extract<FlowOp, { op: 'assign' }>;

const loc = (node: Node): Loc => [node.startPosition.row, node.startPosition.column];

export interface FlowExtraction {
  flow: FileFlow;
  includes: IncludeRef[];
}

/** `inferrer` : types des affectations du niveau fichier (transmis aux fichiers qui l'incluent). */
export function extractFlow(root: Node, scopes: NameScope[], inferrer?: Inferrer): FlowExtraction {
  const builder = new FlowBuilder(scopes, inferrer);
  const main = builder.scope(root, true);
  return { flow: { main: [...builder.fileVariables(root), ...main], functions: builder.functions }, includes: builder.includes };
}

/** Valeur d'un appel `extract(…)`, `isset(…)` : arguments (valeur des arguments nommés comprise). */
function argumentValues(call: Node): Node[] {
  return (call.childForFieldName('arguments')?.namedChildren ?? [])
    .filter((a) => a.type === 'argument')
    .map((a) => a.namedChildren[a.namedChildren.length - 1])
    .filter((n): n is Node => !!n);
}

/** Variable de base d'une expression (`$a` pour `$a['k']->p`). */
function baseVariable(node: Node | undefined): Node | undefined {
  let current = node;
  while (current && (current.type === 'subscript_expression' || current.type === 'member_access_expression' || current.type === 'nullsafe_member_access_expression')) {
    current = current.namedChildren[0];
  }
  return current?.type === 'variable_name' ? current : undefined;
}

/** Variables garanties définies quand `condition` vaut `positive` (isset, !empty, combinés par && / ||, !). */
function guardsOf(condition: Node | null | undefined, positive: boolean): Node[] {
  if (!condition) return [];
  switch (condition.type) {
    case 'parenthesized_expression':
      return guardsOf(condition.namedChildren[0], positive);
    case 'unary_op_expression':
      return condition.child(0)?.type === '!' ? guardsOf(condition.namedChildren[condition.namedChildren.length - 1], !positive) : [];
    case 'binary_expression': {
      const op = condition.childForFieldName('operator')?.type ?? '';
      const both = ((op === '&&' || op === 'and') && positive) || ((op === '||' || op === 'or') && !positive);
      return both ? [...guardsOf(condition.childForFieldName('left'), positive), ...guardsOf(condition.childForFieldName('right'), positive)] : [];
    }
    case 'function_call_expression': {
      const fn = condition.childForFieldName('function')?.text.toLowerCase();
      if ((fn === 'isset' && positive) || (fn === 'empty' && !positive)) {
        return argumentValues(condition).map(baseVariable).filter((n): n is Node => !!n);
      }
      return [];
    }
    default:
      return [];
  }
}

function parameterNames(fn: Node): string[] {
  return (fn.childForFieldName('parameters')?.namedChildren ?? [])
    .map((p) => p.childForFieldName('name')?.text.slice(1))
    .filter((n): n is string => !!n);
}

/** Valeur d'une chaîne littérale sans interpolation. */
function literal(node: Node): string | undefined {
  if (node.type !== 'string' && node.type !== 'encapsed_string') return undefined;
  if (node.namedChildren.some((c) => c.type !== 'string_content' && c.type !== 'escape_sequence')) return undefined;
  return node.text.slice(1, -1);
}

/** Affectations simples par variable dans une portée (valeurs pour les chemins) ; null : définie autrement. */
function collectAssignments(body: Node): Map<string, (Node | null)[]> {
  const out = new Map<string, (Node | null)[]>();
  const add = (name: string, value: Node | null) => {
    const list = out.get(name);
    if (list) list.push(value);
    else out.set(name, [value]);
  };
  const visit = (node: Node): void => {
    for (const child of node.namedChildren) {
      if (CLASS_NODES.has(child.type) || child.type === 'function_definition' || child.type === 'anonymous_function' || child.type === 'arrow_function' || child.type === 'method_declaration') continue;
      if (child.type === 'assignment_expression' || child.type === 'augmented_assignment_expression' || child.type === 'reference_assignment_expression') {
        const left = child.childForFieldName('left');
        if (left?.type === 'variable_name') add(left.text.slice(1), child.type === 'assignment_expression' ? child.childForFieldName('right') : null);
      }
      visit(child);
    }
  };
  visit(body);
  return out;
}

class FlowBuilder {
  readonly functions: FlowFunction[] = [];
  readonly includes: IncludeRef[] = [];
  readonly #scopes: NameScope[];
  readonly #inferrer?: Inferrer;
  #locals = new Map<string, (Node | null)[]>();
  #typed = false;
  /** Symboles déjà utilisés dans la portée : seule la première utilisation est gardée */
  #used = new Set<string>();

  constructor(scopes: NameScope[], inferrer?: Inferrer) {
    this.#scopes = scopes;
    this.#inferrer = inferrer;
  }

  /** Programme d'une portée : corps du fichier (`typed` : types des affectations) ou d'une fonction. */
  scope(body: Node, typed: boolean): FlowOp[] {
    const saved = { locals: this.#locals, typed: this.#typed, used: this.#used };
    this.#locals = collectAssignments(body);
    this.#used = new Set();
    this.#typed = typed && !!this.#inferrer;
    const ops: FlowOp[] = [];
    this.#statements(body.namedChildren, ops);
    this.#locals = saved.locals;
    this.#typed = saved.typed;
    this.#used = saved.used;
    return ops;
  }

  /** Variables déclarées en tête de fichier par `/** @var Type $nom *\/` (définies de l'extérieur). */
  fileVariables(root: Node): FlowOp[] {
    const out: FlowOp[] = [];
    for (const child of root.namedChildren) {
      if (child.type === 'php_tag') continue;
      if (child.type !== 'comment') break;
      if (!child.text.startsWith('/**')) continue;
      for (const entry of docVar(cleanDoc(child.text))) {
        if (!entry.name) continue;
        const op: Assign = { op: 'assign', name: entry.name.replace(/^\$/, ''), at: loc(child) };
        const type = parseDocType(entry.type, this.#scopes[0]);
        if (type) op.type = type;
        out.push(op);
      }
    }
    return out;
  }

  readonly #local = (name: string, before: number): Node | undefined => {
    const values = this.#locals.get(name);
    const value = values?.length === 1 ? values[0] : undefined;
    return value && value.startIndex < before ? value : undefined;
  };

  #scopeOf(node: Node): NameScope {
    return scopeAt(this.#scopes, rangeOf(node).start);
  }

  #ops(fill: (out: FlowOp[]) => void): FlowOp[] {
    const out: FlowOp[] = [];
    fill(out);
    return out;
  }

  /** Branche ajoutée seulement si l'une des alternatives fait quelque chose. */
  #branch(out: FlowOp[], alts: FlowOp[][], exhaustive: boolean): void {
    if (alts.some((alt) => alt.length)) out.push({ op: 'branch', alts, exhaustive });
  }

  #guards(nodes: Node[]): FlowOp[] {
    return nodes.map((n): FlowOp => ({ op: 'assign', name: n.text.slice(1), at: loc(n), guard: true })).filter((o) => !ALWAYS_DEFINED.has((o as Assign).name));
  }

  #block(node: Node | null | undefined): FlowOp[] {
    const ops: FlowOp[] = [];
    if (node) this.#statement(node, ops);
    return ops;
  }

  #statements(nodes: Node[], out: FlowOp[]): void {
    for (const node of nodes) this.#statement(node, out);
  }

  #statement(node: Node, out: FlowOp[]): void {
    switch (node.type) {
      case 'compound_statement':
      case 'colon_block':
        return this.#statements(node.namedChildren, out);
      case 'expression_statement':
        return this.#exprs(node.namedChildren, out);
      case 'if_statement':
        return this.#if(node, out);
      case 'switch_statement':
        return this.#switch(node, out);
      case 'while_statement':
        this.#expr(node.childForFieldName('condition'), out);
        out.push({ op: 'loop', body: this.#block(node.childForFieldName('body')) });
        return;
      case 'do_statement':
        out.push(...this.#block(node.childForFieldName('body')));
        this.#expr(node.childForFieldName('condition'), out);
        return;
      case 'for_statement':
        return this.#for(node, out);
      case 'foreach_statement':
        return this.#foreach(node, out);
      case 'try_statement':
        return this.#try(node, out);
      case 'return_statement':
        this.#exprs(node.namedChildren, out);
        out.push({ op: 'exit', ret: true });
        return;
      case 'exit_statement':
        this.#exprs(node.namedChildren, out);
        out.push({ op: 'exit' });
        return;
      case 'global_declaration':
        for (const variable of node.namedChildren) if (variable.type === 'variable_name') this.#assign(variable, out);
        return;
      case 'function_static_declaration':
        for (const declaration of node.namedChildren) {
          this.#expr(declaration.childForFieldName('value'), out);
          const name = declaration.childForFieldName('name');
          if (name) this.#assign(name, out);
        }
        return;
      case 'unset_statement':
        for (const variable of node.namedChildren) if (variable.type === 'variable_name') out.push({ op: 'unset', name: variable.text.slice(1) });
        return;
      case 'function_definition':
        return this.#function(node, node.childForFieldName('name')?.text ?? 'function', []);
      case 'class_declaration':
      case 'interface_declaration':
      case 'trait_declaration':
      case 'enum_declaration':
        return this.#class(node, out);
      case 'const_declaration':
        for (const element of node.namedChildren) {
          if (element.type !== 'const_element') continue;
          const [name, value] = element.namedChildren;
          this.#expr(value, out);
          if (name && value) {
            const namespace = this.#scopeOf(name).namespace;
            out.push({ op: 'define', name: namespace ? `${namespace}\\${name.text}` : name.text, value: pathExprOf(value, this.#local) });
          }
        }
        return;
      case 'namespace_definition':
        this.#statements(node.childForFieldName('body')?.namedChildren ?? [], out);
        return;
      case 'namespace_use_declaration':
      case 'comment':
      case 'text_interpolation':
      case 'break_statement':
      case 'continue_statement':
        return;
      default:
        return this.#exprs(node.namedChildren, out);
    }
  }

  #if(node: Node, out: FlowOp[]): void {
    const condition = node.childForFieldName('condition');
    this.#expr(condition, out);
    const alts: FlowOp[][] = [[...this.#guards(guardsOf(condition, true)), ...this.#block(node.childForFieldName('body'))]];
    let exhaustive = false;
    for (let i = 0; i < node.childCount; i++) {
      if (node.fieldNameForChild(i) !== 'alternative') continue;
      const clause = node.child(i)!;
      if (clause.type === 'else_clause') {
        alts.push([...this.#guards(guardsOf(condition, false)), ...this.#block(clause.childForFieldName('body'))]);
        exhaustive = true;
      } else {
        // elseif : sa condition n'est évaluée que si les précédentes sont fausses
        const elseCondition = clause.childForFieldName('condition');
        alts.push(this.#ops((ops) => {
          this.#expr(elseCondition, ops);
          ops.push(...this.#guards(guardsOf(elseCondition, true)));
          ops.push(...this.#block(clause.childForFieldName('body')));
        }));
      }
    }
    if (!exhaustive && alts.length === 1) {
      // Sans else : le chemin où la condition est fausse garantit les variables de `!isset(…)`
      const negative = this.#guards(guardsOf(condition, false));
      if (negative.length) {
        alts.push(negative);
        exhaustive = true;
      }
    }
    this.#branch(out, alts, exhaustive);
  }

  #switch(node: Node, out: FlowOp[]): void {
    this.#expr(node.childForFieldName('condition'), out);
    const cases = (node.childForFieldName('body')?.namedChildren ?? []).filter((c) => c.type === 'case_statement' || c.type === 'default_statement');
    const alts: FlowOp[][] = [];
    for (let i = 0; i < cases.length; i++) {
      const ops: FlowOp[] = [];
      // Sans break, l'exécution continue dans les cas suivants
      for (let j = i; j < cases.length; j++) {
        const value = cases[j].childForFieldName('value');
        const statements = cases[j].namedChildren.filter((c) => c.id !== value?.id);
        this.#statements(statements, ops);
        if (statements.some((s) => TERMINATORS.has(s.type) || (s.type === 'expression_statement' && s.namedChildren[0]?.type === 'throw_expression'))) break;
      }
      alts.push(ops);
    }
    this.#branch(out, alts, cases.some((c) => c.type === 'default_statement'));
  }

  #for(node: Node, out: FlowOp[]): void {
    const body: FlowOp[] = [];
    const update: Node[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const field = node.fieldNameForChild(i);
      const child = node.child(i)!;
      if (field === 'initialize' || field === 'condition') this.#expr(child, out);
      else if (field === 'update') update.push(child);
    }
    const statements = node.childForFieldName('body');
    if (statements) this.#statement(statements, body);
    else {
      // Syntaxe alternative (`for (…): … endfor`) : instructions sans champ
      for (let i = 0; i < node.childCount; i++) if (!node.fieldNameForChild(i) && node.child(i)!.isNamed) this.#statement(node.child(i)!, body);
    }
    this.#exprs(update, body);
    out.push({ op: 'loop', body });
  }

  #foreach(node: Node, out: FlowOp[]): void {
    const body = node.childForFieldName('body');
    const [subject, target] = node.namedChildren.filter((c) => c.id !== body?.id);
    this.#expr(subject, out);
    const ops: FlowOp[] = [];
    if (target) {
      const parts = target.type === 'pair' ? target.namedChildren : [target];
      for (const part of parts) this.#target(part.type === 'by_ref' ? part.namedChildren[0] : part, ops);
    }
    ops.push(...this.#block(body));
    out.push({ op: 'loop', body: ops });
  }

  #try(node: Node, out: FlowOp[]): void {
    const alts: FlowOp[][] = [this.#block(node.childForFieldName('body'))];
    let final: Node | undefined;
    for (const clause of node.namedChildren) {
      if (clause.type === 'catch_clause') {
        alts.push(this.#ops((ops) => {
          const name = clause.childForFieldName('name');
          if (name) this.#assign(name, ops);
          ops.push(...this.#block(clause.childForFieldName('body')));
        }));
      } else if (clause.type === 'finally_clause') {
        final = clause;
      }
    }
    if (alts.length > 1) this.#branch(out, alts, true);
    else out.push(...alts[0]);
    if (final) this.#statement(final.childForFieldName('body') ?? final, out);
  }

  #function(node: Node, name: string, extra: string[]): void {
    const body = node.childForFieldName('body');
    if (!body) return;
    const params = [...parameterNames(node), ...extra];
    this.functions.push({ name, params, lines: [node.startPosition.row, node.endPosition.row], body: this.scope(body, false) });
  }

  #class(node: Node, out: FlowOp[]): void {
    // Parents et interfaces : chargés avant la déclaration de la classe
    for (const clause of node.namedChildren) {
      if (clause.type !== 'base_clause' && clause.type !== 'class_interface_clause') continue;
      for (const name of clause.namedChildren) if (NAME_TYPES.has(name.type)) this.#useClass(name, out);
    }
    const className = node.childForFieldName('name')?.text ?? 'class';
    for (const member of node.childForFieldName('body')?.namedChildren ?? []) {
      if (member.type !== 'method_declaration') continue;
      const isStatic = member.namedChildren.some((c) => c.type === 'static_modifier');
      this.#function(member, `${className}::${member.childForFieldName('name')?.text ?? ''}`, isStatic ? [] : ['this']);
    }
  }

  #exprs(nodes: Node[], out: FlowOp[], quiet = false): void {
    for (const node of nodes) this.#expr(node, out, quiet);
  }

  /** Opérations d'une expression ; `quiet` : les variables ne sont pas lues (isset, empty, ??, @). */
  #expr(node: Node | null | undefined, out: FlowOp[], quiet = false): void {
    if (!node) return;
    switch (node.type) {
      case 'variable_name': {
        const name = node.text.slice(1);
        if (!quiet && !ALWAYS_DEFINED.has(name)) out.push({ op: 'read', name, at: loc(node), end: node.endPosition.column });
        return;
      }
      case 'name':
      case 'qualified_name':
        return this.#useConstant(node, out);
      case 'assignment_expression':
        this.#expr(node.childForFieldName('right'), out, quiet);
        return this.#target(node.childForFieldName('left'), out, quiet, node.childForFieldName('right'));
      case 'reference_assignment_expression': {
        // `$a = &$b` : $b est créée si besoin
        const right = node.childForFieldName('right');
        if (right?.type === 'variable_name') this.#assign(right, out);
        else this.#expr(right, out, quiet);
        return this.#target(node.childForFieldName('left'), out, quiet);
      }
      case 'augmented_assignment_expression': {
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (node.childForFieldName('operator')?.text === '??=') {
          this.#branch(out, [this.#ops((ops) => this.#expr(right, ops, quiet))], false);
          return this.#target(left, out, true);
        }
        this.#expr(left, out, quiet);
        this.#expr(right, out, quiet);
        return this.#target(left, out, true);
      }
      case 'binary_expression':
        return this.#binary(node, out, quiet);
      case 'conditional_expression': {
        const condition = node.childForFieldName('condition');
        const body = node.childForFieldName('body');
        const alternative = node.childForFieldName('alternative');
        this.#expr(condition, out, quiet);
        if (!body) {
          // `a ?: b`
          this.#branch(out, [this.#ops((ops) => this.#expr(alternative, ops, quiet))], false);
          return;
        }
        this.#branch(out, [
          [...this.#guards(guardsOf(condition, true)), ...this.#ops((ops) => this.#expr(body, ops, quiet))],
          [...this.#guards(guardsOf(condition, false)), ...this.#ops((ops) => this.#expr(alternative, ops, quiet))],
        ], true);
        return;
      }
      case 'function_call_expression':
        return this.#call(node, out, quiet);
      case 'member_call_expression':
      case 'nullsafe_member_call_expression':
        this.#expr(node.childForFieldName('object'), out, quiet);
        return this.#arguments(node, out, quiet, [], node.childForFieldName('name')?.text);
      case 'scoped_call_expression':
        this.#useScope(node.childForFieldName('scope'), out, quiet);
        return this.#arguments(node, out, quiet, [], node.childForFieldName('name')?.text);
      case 'member_access_expression':
      case 'nullsafe_member_access_expression': {
        this.#expr(node.childForFieldName('object'), out, quiet);
        const name = node.childForFieldName('name');
        if (name && !NAME_TYPES.has(name.type)) this.#expr(name, out, quiet);
        return;
      }
      case 'class_constant_access_expression':
      case 'scoped_property_access_expression':
        return this.#useScope(node.namedChildren[0], out, quiet);
      case 'object_creation_expression': {
        const [cls, ...rest] = node.namedChildren;
        if (cls && NAME_TYPES.has(cls.type)) this.#useClass(cls, out);
        else if (cls?.type !== 'anonymous_class') this.#expr(cls, out, quiet);
        return this.#exprs(rest, out, quiet);
      }
      case 'anonymous_function':
        return this.#closure(node, out, quiet);
      case 'arrow_function': {
        const ops: FlowOp[] = parameterNames(node).map((name): FlowOp => ({ op: 'assign', name, at: loc(node) }));
        this.#expr(node.childForFieldName('body'), ops, quiet);
        return this.#branch(out, [ops], false);
      }
      case 'include_expression':
      case 'include_once_expression':
      case 'require_expression':
      case 'require_once_expression':
        return this.#include(node, out, quiet);
      case 'throw_expression':
        this.#exprs(node.namedChildren, out, quiet);
        out.push({ op: 'exit' });
        return;
      case 'error_suppression_expression':
        return this.#exprs(node.namedChildren, out, true);
      case 'update_expression': {
        // `$i++` : lecture puis affectation
        const target = node.namedChildren[0];
        this.#expr(target, out, quiet);
        return this.#target(target, out, true);
      }
      case 'dynamic_variable_name':
        this.#exprs(node.namedChildren, out, quiet);
        return;
      case 'match_expression':
        return this.#match(node, out, quiet);
      case 'anonymous_class':
      case 'class_declaration':
      case 'list_literal':
        return;
      default:
        for (const child of node.namedChildren) {
          if (NAME_TYPES.has(child.type)) {
            if (CONSTANT_PARENTS.has(node.type)) this.#useConstant(child, out);
          } else {
            this.#expr(child, out, quiet);
          }
        }
    }
  }

  #binary(node: Node, out: FlowOp[], quiet: boolean): void {
    const op = node.childForFieldName('operator')?.type ?? '';
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if (op === '??') {
      this.#expr(left, out, true);
      return this.#branch(out, [this.#ops((ops) => this.#expr(right, ops, quiet))], false);
    }
    if (op === 'instanceof') {
      this.#expr(left, out, quiet);
      if (right?.type === 'variable_name') this.#expr(right, out, quiet);
      return;
    }
    this.#expr(left, out, quiet);
    if (SHORT_CIRCUIT.has(op)) {
      // Partie droite évaluée seulement si la gauche est vraie (&&) ou fausse (||)
      const guards = this.#guards(guardsOf(left, op === '&&' || op === 'and'));
      this.#branch(out, [[...guards, ...this.#ops((ops) => this.#expr(right, ops, quiet))]], false);
      return;
    }
    this.#expr(right, out, quiet);
  }

  #match(node: Node, out: FlowOp[], quiet: boolean): void {
    this.#expr(node.childForFieldName('condition'), out, quiet);
    const arms = node.childForFieldName('body')?.namedChildren ?? [];
    const alts = arms.map((arm) => this.#ops((ops) => this.#exprs(arm.namedChildren, ops, quiet)));
    this.#branch(out, alts, arms.some((a) => a.type === 'match_default_expression'));
  }

  /** Cible d'une affectation : variable, liste, élément de tableau (crée la variable), propriété (lit l'objet). */
  #target(left: Node | null | undefined, out: FlowOp[], quiet = false, value?: Node | null): void {
    if (!left) return;
    switch (left.type) {
      case 'variable_name':
        return this.#assign(left, out, value);
      case 'by_ref':
        return this.#target(left.namedChildren[0], out, quiet);
      case 'list_literal':
      case 'array_creation_expression':
        for (const item of left.namedChildren) {
          const target = item.type === 'pair' || item.type === 'array_element_initializer' ? item.namedChildren[item.namedChildren.length - 1] : item;
          this.#target(target, out, quiet);
        }
        return;
      case 'subscript_expression': {
        let base: Node | undefined = left;
        const indexes: Node[] = [];
        while (base?.type === 'subscript_expression') {
          indexes.push(...base.namedChildren.slice(1));
          base = base.namedChildren[0];
        }
        this.#exprs(indexes, out, quiet);
        // `$a[] = 1` crée $a ; `$o->t[] = 1` lit $o
        if (base?.type === 'variable_name') this.#assign(base, out);
        else this.#expr(base, out, quiet);
        return;
      }
      case 'dynamic_variable_name':
        this.#exprs(left.namedChildren, out, quiet);
        out.push({ op: 'dynamic', at: loc(left) });
        return;
      default:
        return this.#expr(left, out, quiet);
    }
  }

  #assign(variable: Node, out: FlowOp[], value?: Node | null): void {
    if (variable.type !== 'variable_name') return;
    const name = variable.text.slice(1);
    if (ALWAYS_DEFINED.has(name)) return;
    const op: Assign = { op: 'assign', name, at: loc(variable) };
    if (this.#typed && value) {
      const type = this.#inferrer!.expr(value);
      if (type.kind !== 'mixed' && JSON.stringify(type).length <= MAX_TYPE) op.type = type;
    }
    out.push(op);
  }

  #call(node: Node, out: FlowOp[], quiet: boolean): void {
    const fn = node.childForFieldName('function');
    if (!fn || !NAME_TYPES.has(fn.type)) {
      this.#expr(fn, out, quiet);
      return this.#arguments(node, out, quiet, []);
    }
    const args = argumentValues(node);
    switch (fn.text.replace(/^\\/, '').toLowerCase()) {
      case 'isset':
      case 'empty':
        return this.#exprs(args, out, true);
      case 'compact':
        return;
      case 'extract':
        return this.#extract(node, args, out, quiet);
      case 'eval':
      case 'get_defined_vars':
        this.#exprs(args, out, quiet);
        out.push({ op: 'dynamic', at: loc(node) });
        return;
      case 'parse_str':
        this.#expr(args[0], out, quiet);
        if (args.length < 2) out.push({ op: 'dynamic', at: loc(node) });
        else this.#target(args[1], out, quiet);
        return;
      case 'define': {
        this.#exprs(args, out, quiet);
        const name = args[0] && literal(args[0]);
        if (name && args[1]) out.push({ op: 'define', name: name.replace(/^\\/, ''), value: pathExprOf(args[1], this.#local) });
        return;
      }
      case 'spl_autoload_register':
        this.#exprs(args, out, quiet);
        out.push({ op: 'autoload' });
        return;
      case 'die':
      case 'exit':
        this.#exprs(args, out, quiet);
        out.push({ op: 'exit' });
        return;
    }
    const names = resolveFunctionOrConstant(fn.text, 'function', this.#scopeOf(fn));
    this.#use('function', names, fn, out);
    this.#arguments(node, out, quiet, names);
  }

  /** Arguments : variables nues gardées pour savoir si le paramètre est par référence, le reste lu. */
  #arguments(node: Node, out: FlowOp[], quiet: boolean, names: string[], method?: string): void {
    const args: FlowArg[] = [];
    let index = 0;
    for (const argument of node.childForFieldName('arguments')?.namedChildren ?? []) {
      if (argument.type !== 'argument') {
        this.#expr(argument, out, quiet);
        continue;
      }
      const value = argument.namedChildren[argument.namedChildren.length - 1];
      const named = argument.childForFieldName('name');
      if (value?.type === 'variable_name' && !named && !ALWAYS_DEFINED.has(value.text.slice(1))) {
        args.push({ index, name: value.text.slice(1), at: loc(value), end: value.endPosition.column });
      } else {
        this.#expr(value, out, quiet);
      }
      index++;
    }
    if (!args.length || quiet) return;
    const call: FlowOp = method ? { op: 'call', names, method, args } : { op: 'call', names, args };
    out.push(call);
  }

  #extract(node: Node, args: Node[], out: FlowOp[], quiet: boolean): void {
    const source = args[0];
    if (!source) return;
    if (REQUEST.has(source.text)) {
      out.push({ op: 'extract', source: 'request', from: source.text, at: loc(node) });
      return;
    }
    if (source.type === 'array_creation_expression') {
      const keys = source.namedChildren.map((element) => {
        const key = element.type === 'array_element_initializer' && element.namedChildren.length === 2 ? element.namedChildren[0] : undefined;
        return key && literal(key);
      });
      this.#expr(source, out, quiet);
      if (keys.every((k) => k)) {
        for (const key of keys) out.push({ op: 'assign', name: key!, at: loc(node) });
        return;
      }
    } else {
      this.#expr(source, out, quiet);
    }
    out.push({ op: 'extract', source: 'other', at: loc(node) });
  }

  #closure(node: Node, out: FlowOp[], quiet: boolean): void {
    const params = parameterNames(node);
    for (const item of node.namedChildren.find((c) => c.type === 'anonymous_function_use_clause')?.namedChildren ?? []) {
      const variable = item.type === 'by_ref' ? item.namedChildren[0] : item;
      if (variable?.type !== 'variable_name') continue;
      if (item.type === 'by_ref') this.#assign(variable, out);
      else this.#expr(variable, out, quiet);
      params.push(variable.text.slice(1));
    }
    const body = node.childForFieldName('body');
    if (body) this.functions.push({ name: 'closure', params: [...params, 'this'], lines: [node.startPosition.row, node.endPosition.row], body: this.scope(body, false) });
  }

  #include(node: Node, out: FlowOp[], quiet: boolean): void {
    let path = node.namedChildren[0];
    if (path?.type === 'parenthesized_expression') path = path.namedChildren[0];
    this.#expr(path, out, quiet);
    const hint = includeHint(node);
    const ref: IncludeRef = {
      kind: INCLUDE_KINDS[node.type],
      range: rangeOf(node),
      expression: path ? squash(path.text) : '',
      path: hint ? { k: 'lit', v: hint } : pathExprOf(path, this.#local),
    };
    if (hint) ref.hint = true;
    out.push({ op: 'include', index: this.includes.length });
    this.includes.push(ref);
  }

  /** Utilisation d'un symbole, gardée seulement la première fois dans la portée. */
  #use(kind: 'function' | 'class' | 'constant', names: string[], name: Node, out: FlowOp[]): void {
    const key = `${kind}:${names[0]?.toLowerCase()}`;
    if (this.#used.has(key)) return;
    this.#used.add(key);
    out.push({ op: 'use', kind, names, at: loc(name), end: name.endPosition.column });
  }

  #useClass(name: Node, out: FlowOp[]): void {
    if (SELF.has(name.text.toLowerCase())) return;
    const fqn = resolveClassName(name.text, this.#scopeOf(name));
    if (fqn) this.#use('class', [fqn], name, out);
  }

  /** Portée d'un accès statique : nom de classe, ou expression (`$obj::m()`). */
  #useScope(scope: Node | null | undefined, out: FlowOp[], quiet: boolean): void {
    if (!scope) return;
    if (NAME_TYPES.has(scope.type)) this.#useClass(scope, out);
    else if (scope.type !== 'relative_scope') this.#expr(scope, out, quiet);
  }

  #useConstant(name: Node, out: FlowOp[]): void {
    if (NOT_CONSTANTS.has(name.text.toLowerCase())) return;
    const names = resolveFunctionOrConstant(name.text, 'constant', this.#scopeOf(name));
    this.#use('constant', names, name, out);
  }
}
