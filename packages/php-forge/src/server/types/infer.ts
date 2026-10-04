// Type d'une expression depuis l'arbre du fichier, sans l'index : ce qui dépend d'autres déclarations
// (retour de fonction ou de méthode, propriété, constante) devient un type différé (`ref`) que
// TypeResolver résout ensuite. Une instance par requête (cache par nœud).
import type { NameScope, TypeExpr } from '../../shared/types.ts';
import { containsYield, returnStatements } from '../model/context.ts';
import { resolveClassName, resolveFunctionOrConstant, scopeAt } from '../model/names.ts';
import { rangeOf } from '../model/ranges.ts';
import type { Node } from '../parser/parser.ts';
import { typeFromNode } from './declType.ts';
import { variableType, type Definition } from './flow.ts';
import { classType, MIXED, ref, scalar, union, withoutNull } from './type.ts';

const COMPARISONS = new Set(['==', '!=', '<>', '===', '!==', '<', '>', '<=', '>=', '&&', '||', 'and', 'or', 'xor', 'instanceof']);
const ARITHMETIC = new Set(['+', '-', '*', '/', '%', '**']);
const BITWISE = new Set(['&', '|', '^', '<<', '>>']);
const CASTS: Record<string, TypeExpr> = {
  int: scalar('int'), integer: scalar('int'), bool: scalar('bool'), boolean: scalar('bool'), float: scalar('float'),
  double: scalar('float'), real: scalar('float'), string: scalar('string'), binary: scalar('string'),
  array: { kind: 'array' }, object: classType('stdClass'), unset: scalar('null'),
};
const NAMES = new Set(['name', 'qualified_name', 'relative_name']);
const MAX_DEPTH = 40;

const isInt = (t: TypeExpr) => t.kind === 'scalar' && t.name === 'int';
const isFloat = (t: TypeExpr) => t.kind === 'scalar' && t.name === 'float';

/** Clé littérale d'un tableau : entier ou chaîne sans interpolation. */
export function literalKey(node: Node | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'integer') return node.text;
  if ((node.type === 'string' || node.type === 'encapsed_string') && node.namedChildren.every((c) => c.type === 'string_content')) return node.text.slice(1, -1);
  return undefined;
}

export class Inferrer {
  readonly scopes: NameScope[];
  /** Définitions des variables par portée (fonction ou fichier), calculées une fois par requête */
  readonly definitions = new Map<number, Map<string, Definition[]>>();
  /** Appels assert(…) par bloc, calculés une fois par requête */
  readonly asserts = new Map<number, Node[]>();
  readonly #cache = new Map<number, TypeExpr>();
  #depth = 0;

  constructor(scopes: NameScope[]) {
    this.scopes = scopes;
  }

  scopeOf(node: Node): NameScope {
    return scopeAt(this.scopes, rangeOf(node).start);
  }

  expr(node: Node | null | undefined): TypeExpr {
    if (!node) return MIXED;
    const cached = this.#cache.get(node.id);
    if (cached) return cached;
    if (this.#depth > MAX_DEPTH) return MIXED;
    this.#depth++;
    try {
      const type = this.#compute(node);
      this.#cache.set(node.id, type);
      return type;
    } finally {
      this.#depth--;
    }
  }

  variable(name: string, at: Node): TypeExpr {
    return variableType(this, name, at);
  }

  /** Classe désignée par une portée : `Foo`, `self`, `static`, `parent`, ou une expression (`$obj::`). */
  classOf(node: Node | null | undefined): TypeExpr {
    if (!node) return MIXED;
    if (node.type === 'relative_scope' || NAMES.has(node.type)) {
      const text = node.text.replace(/\s+/g, '');
      const lower = text.toLowerCase();
      if (lower === 'self') return { kind: 'self' };
      if (lower === 'static') return { kind: 'static' };
      if (lower === 'parent') return { kind: 'parent' };
      const fqn = resolveClassName(text, this.scopeOf(node));
      return fqn ? classType(fqn) : MIXED;
    }
    return this.expr(node);
  }

  /** Type de retour déduit du corps d'une fonction (union des return, void sans return, Generator avec yield). */
  inferReturn(fn: Node): TypeExpr | undefined {
    const body = fn.childForFieldName('body');
    if (!body) return undefined;
    if (fn.type === 'arrow_function') return this.expr(body);
    if (containsYield(body)) return classType('Generator');
    const values = returnStatements(body).map((r) => r.namedChildren[0] as Node | undefined);
    if (!values.length) return scalar('void');
    const hasValue = values.some(Boolean);
    return union(...values.map((v) => (v ? this.expr(v) : scalar(hasValue ? 'null' : 'void'))));
  }

  #compute(node: Node): TypeExpr {
    switch (node.type) {
      case 'parenthesized_expression':
      case 'error_suppression_expression':
      case 'clone_expression':
      case 'by_ref':
        return this.expr(node.namedChildren[0]);
      case 'integer':
        return scalar('int');
      case 'float':
        return scalar('float');
      case 'string':
      case 'encapsed_string':
      case 'heredoc':
      case 'nowdoc':
      case 'shell_command_expression':
        return scalar('string');
      case 'boolean':
        return scalar('bool');
      case 'null':
        return scalar('null');
      case 'array_creation_expression':
        return this.#array(node);
      case 'variable_name':
        return this.variable(node.text.slice(1), node);
      case 'object_creation_expression': {
        const target = node.namedChildren[0];
        return target?.type === 'anonymous_class' ? MIXED : this.classOf(target);
      }
      case 'member_call_expression':
      case 'nullsafe_member_call_expression': {
        const name = node.childForFieldName('name');
        if (name?.type !== 'name') return MIXED;
        const type = ref({ of: 'method', name: name.text, on: this.expr(node.childForFieldName('object')), args: this.#args(node) });
        return node.type.startsWith('nullsafe') ? union(type, scalar('null')) : type;
      }
      case 'member_access_expression':
      case 'nullsafe_member_access_expression': {
        const name = node.childForFieldName('name');
        if (name?.type !== 'name') return MIXED;
        const type = ref({ of: 'property', name: name.text, on: this.expr(node.childForFieldName('object')) });
        return node.type.startsWith('nullsafe') ? union(type, scalar('null')) : type;
      }
      case 'scoped_call_expression': {
        const name = node.childForFieldName('name');
        if (name?.type !== 'name') return MIXED;
        return ref({ of: 'method', name: name.text, on: this.classOf(node.childForFieldName('scope')), args: this.#args(node) });
      }
      case 'scoped_property_access_expression': {
        const name = node.childForFieldName('name');
        if (!name) return MIXED;
        return ref({ of: 'property', name: name.text.replace(/^\$/, ''), on: this.classOf(node.childForFieldName('scope')) });
      }
      case 'class_constant_access_expression': {
        const [scope, member] = node.namedChildren;
        if (!member) return MIXED;
        const owner = this.classOf(scope);
        if (member.text.toLowerCase() === 'class') return owner.kind === 'class' ? { kind: 'classString', fqn: owner.fqn } : { kind: 'classString' };
        return ref({ of: 'classConstant', name: member.text, on: owner });
      }
      case 'function_call_expression': {
        const fn = node.childForFieldName('function');
        if (!fn) return MIXED;
        if (NAMES.has(fn.type)) return ref({ of: 'function', names: resolveFunctionOrConstant(fn.text, 'function', this.scopeOf(fn)), args: this.#args(node) });
        const callee = this.expr(fn);
        return callee.kind === 'closure' ? (callee.returns ?? MIXED) : MIXED;
      }
      case 'name':
      case 'qualified_name':
      case 'relative_name':
        if (/^__[A-Z]+__$/.test(node.text)) return node.text === '__LINE__' ? scalar('int') : scalar('string');
        return ref({ of: 'constant', names: resolveFunctionOrConstant(node.text, 'constant', this.scopeOf(node)) });
      case 'binary_expression':
        return this.#binary(node);
      case 'unary_op_expression': {
        const operator = node.childForFieldName('operator')?.text ?? node.children[0]?.text;
        if (operator === '!') return scalar('bool');
        if (operator === '~') return scalar('int');
        return this.#numeric([node.childForFieldName('argument') ?? node.namedChildren[0]]);
      }
      case 'cast_expression':
        return CASTS[node.childForFieldName('type')?.text.toLowerCase().replace(/\s+/g, '') ?? ''] ?? MIXED;
      case 'conditional_expression': {
        const body = node.childForFieldName('body');
        const then = body ? this.expr(body) : withoutNull(this.expr(node.childForFieldName('condition')));
        return union(then, this.expr(node.childForFieldName('alternative')));
      }
      case 'match_expression':
        return union(...(node.childForFieldName('body')?.namedChildren ?? []).map((arm) => this.expr(arm.childForFieldName('return_expression'))));
      case 'assignment_expression':
      case 'reference_assignment_expression':
        return this.expr(node.childForFieldName('right'));
      case 'augmented_assignment_expression':
        return this.#augmented(node);
      case 'anonymous_function': {
        const declared = typeFromNode(node.childForFieldName('return_type'), this.scopeOf(node));
        const returns = declared ?? this.inferReturn(node);
        return returns ? { kind: 'closure', returns } : { kind: 'closure' };
      }
      case 'arrow_function':
        return { kind: 'closure', returns: this.expr(node.childForFieldName('body')) };
      case 'subscript_expression': {
        const [target, index] = node.namedChildren;
        const key = literalKey(index);
        return ref(key === undefined ? { of: 'offset', on: this.expr(target) } : { of: 'offset', key, on: this.expr(target) });
      }
      case 'update_expression':
      case 'print_intrinsic':
        return scalar('int');
      case 'throw_expression':
        return scalar('never');
      default:
        return MIXED;
    }
  }

  #args(call: Node): TypeExpr[] {
    return (call.childForFieldName('arguments')?.namedChildren ?? [])
      .filter((a) => a.type === 'argument')
      .map((a) => this.expr(a.namedChildren[a.namedChildren.length - 1]));
  }

  #array(node: Node): TypeExpr {
    const elements = node.namedChildren.filter((c) => c.type === 'array_element_initializer');
    if (!elements.length) return { kind: 'array' };
    const values: TypeExpr[] = [];
    const keys: TypeExpr[] = [];
    const shape: Record<string, TypeExpr> = {};
    let keyed = 0;
    let literal = 0;
    for (const element of elements) {
      const parts = element.namedChildren;
      const valueNode = parts[parts.length - 1];
      if (valueNode?.type === 'variadic_unpacking') {
        values.push(ref({ of: 'element', on: this.expr(valueNode.namedChildren[0]) }));
        continue;
      }
      const value = this.expr(valueNode);
      values.push(value);
      if (parts.length === 2) {
        keyed++;
        keys.push(this.expr(parts[0]));
        const key = literalKey(parts[0]);
        if (key !== undefined) {
          literal++;
          shape[key] = value;
        }
      }
    }
    if (keyed === 0) return { kind: 'array', list: true, value: union(...values) };
    if (keyed === elements.length && literal === keyed && keyed <= 50) return { kind: 'array', shape };
    return { kind: 'array', key: union(...keys), value: union(...values) };
  }

  #binary(node: Node): TypeExpr {
    const operator = node.childForFieldName('operator')?.text.toLowerCase() ?? '';
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if (operator === '.') return scalar('string');
    if (operator === '??') return union(withoutNull(this.expr(left)), this.expr(right));
    if (operator === '<=>') return scalar('int');
    if (COMPARISONS.has(operator)) return scalar('bool');
    if (BITWISE.has(operator)) return scalar('int');
    if (operator === '+') {
      const l = this.expr(left);
      if (l.kind === 'array') return l;
    }
    if (operator === '/') return union(scalar('int'), scalar('float'));
    if (ARITHMETIC.has(operator)) return this.#numeric([left, right]);
    return MIXED;
  }

  #augmented(node: Node): TypeExpr {
    const operator = node.childForFieldName('operator')?.text ?? '';
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if (operator === '.=') return scalar('string');
    if (operator === '??=') return union(withoutNull(this.expr(left)), this.expr(right));
    if (operator === '/=') return union(scalar('int'), scalar('float'));
    if (['+=', '-=', '*=', '%=', '**='].includes(operator)) return this.#numeric([left, right]);
    if (['&=', '|=', '^=', '<<=', '>>='].includes(operator)) return scalar('int');
    return MIXED;
  }

  #numeric(nodes: (Node | null | undefined)[]): TypeExpr {
    const types = nodes.map((n) => this.expr(n));
    if (types.every(isInt)) return scalar('int');
    if (types.some(isFloat)) return scalar('float');
    return union(scalar('int'), scalar('float'));
  }
}
