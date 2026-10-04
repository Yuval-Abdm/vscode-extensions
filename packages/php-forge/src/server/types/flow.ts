// Type d'une variable à un point du code : définitions visibles dans sa portée (fonction ou fichier) —
// affectations, paramètres, foreach, catch, list(), static, global, @var en ligne. La dernière l'emporte,
// sauf si elle est conditionnelle (union avec les précédentes) ; puis rétrécissement par les conditions
// qui entourent le point (instanceof, is_*, null, assert).
import type { TypeExpr } from '../../shared/types.ts';
import { CLASS_DECLARATIONS, FUNCTION_NODES, templatesAround } from '../model/context.ts';
import { cleanDoc, docComment, docVar } from '../model/phpdoc.ts';
import type { Node } from '../parser/parser.ts';
import { typeFromNode } from './declType.ts';
import { parseDocType } from './docType.ts';
import { literalKey, type Inferrer } from './infer.ts';
import { parametersOf } from './params.ts';
import { MIXED, ref, scalar, union, withoutNull } from './type.ts';

export interface Definition {
  /** Position à partir de laquelle la définition est visible */
  from: number;
  /** Nœud de la définition, pour savoir si elle est conditionnelle */
  anchor: Node;
  type: () => TypeExpr;
}

const BRANCHES = new Set([
  'if_statement', 'else_clause', 'else_if_clause', 'switch_statement', 'case_statement', 'default_statement',
  'while_statement', 'do_statement', 'for_statement', 'foreach_statement', 'try_statement', 'catch_clause',
  'finally_clause', 'conditional_expression', 'match_expression',
]);
const SUPERGLOBALS = new Set(['GLOBALS', '_SERVER', '_GET', '_POST', '_FILES', '_COOKIE', '_SESSION', '_REQUEST', '_ENV']);
const SUPERGLOBAL: TypeExpr = { kind: 'array', key: scalar('string'), value: MIXED };
const TYPE_CHECKS: Record<string, TypeExpr> = {
  is_string: scalar('string'), is_int: scalar('int'), is_integer: scalar('int'), is_long: scalar('int'),
  is_float: scalar('float'), is_double: scalar('float'), is_bool: scalar('bool'), is_array: { kind: 'array' },
  is_object: scalar('object'), is_callable: scalar('callable'), is_iterable: scalar('iterable'),
  is_resource: scalar('resource'), is_null: scalar('null'),
};

/** Portée d'un nœud : la fonction (ou closure, fonction fléchée, méthode) englobante, sinon le fichier. */
export function scopeRoot(node: Node): Node {
  for (let n = node.parent; n; n = n.parent) if (FUNCTION_NODES.has(n.type)) return n;
  let root = node;
  while (root.parent) root = root.parent;
  return root;
}

export function variableType(inf: Inferrer, name: string, at: Node): TypeExpr {
  if (name === 'this') return { kind: 'static' };
  if (SUPERGLOBALS.has(name)) return SUPERGLOBAL;
  const root = scopeRoot(at);
  const pos = at.startIndex;
  const visible = (definitionsOf(inf, root).get(name) ?? []).filter((d) => d.from <= pos);
  const types: TypeExpr[] = [];
  for (let i = visible.length - 1; i >= 0; i--) {
    types.push(visible[i].type());
    if (!isConditional(visible[i].anchor, pos, root)) break;
  }
  let type: TypeExpr;
  if (types.length) type = union(...types);
  else if (root.type === 'arrow_function') type = variableType(inf, name, root);
  else type = MIXED;
  return narrow(inf, type, name, at, root);
}

function isConditional(anchor: Node, pos: number, root: Node): boolean {
  for (let n: Node | null = anchor; n && n.id !== root.id; n = n.parent) {
    if (BRANCHES.has(n.type) && !(n.startIndex <= pos && pos <= n.endIndex)) return true;
  }
  return false;
}

function once(compute: () => TypeExpr): () => TypeExpr {
  let value: TypeExpr | undefined;
  return () => (value ??= compute());
}

function definitionsOf(inf: Inferrer, root: Node): Map<string, Definition[]> {
  const cached = inf.definitions.get(root.id);
  if (cached) return cached;
  const map = new Map<string, Definition[]>();
  const add = (name: string, from: number, anchor: Node, type: () => TypeExpr) => {
    const definition = { from, anchor, type: once(type) };
    const list = map.get(name);
    if (list) list.push(definition);
    else map.set(name, [definition]);
  };

  if (FUNCTION_NODES.has(root.type)) {
    for (const param of parametersOf(root, inf.scopeOf(root), templatesAround(root))) {
      const type = param.type ?? MIXED;
      add(param.name, root.startIndex, root, () => (param.variadic ? { kind: 'array', list: true, value: type } : type));
    }
    for (const use of root.namedChildren.find((c) => c.type === 'anonymous_function_use_clause')?.namedChildren ?? []) {
      const variable = use.type === 'by_ref' ? use.namedChildren[0] : use;
      if (variable?.type !== 'variable_name') continue;
      const name = variable.text.slice(1);
      add(name, root.startIndex, root, () => inf.variable(name, root));
    }
  }

  const destructure = (list: Node, source: () => TypeExpr, from: number, anchor: Node): void => {
    let index = 0;
    let key: string | undefined;
    for (const item of list.namedChildren) {
      if (item.type === 'string' || item.type === 'encapsed_string' || item.type === 'integer') {
        key = literalKey(item);
        continue;
      }
      const target = item.type === 'by_ref' ? item.namedChildren[0] : item;
      const offset = key ?? String(index++);
      key = undefined;
      const type = () => ref({ of: 'offset', key: offset, on: source() });
      if (target?.type === 'variable_name') add(target.text.slice(1), from, anchor, type);
      else if (target?.type === 'list_literal') destructure(target, type, from, anchor);
    }
  };

  /** `/** @var Type *\/` juste avant l'instruction d'affectation. */
  const annotation = (assignment: Node, name: string): TypeExpr | undefined => {
    const statement = assignment.parent?.type === 'expression_statement' ? assignment.parent : undefined;
    const doc = statement && docComment(statement);
    const entry = docVar(doc).find((v) => !v.name || v.name === name);
    return entry ? parseDocType(entry.type, inf.scopeOf(assignment)) : undefined;
  };

  const visit = (node: Node): void => {
    for (const child of node.namedChildren) {
      if (FUNCTION_NODES.has(child.type) || CLASS_DECLARATIONS.has(child.type) || child.type === 'anonymous_class') continue;
      switch (child.type) {
        case 'assignment_expression':
        case 'reference_assignment_expression': {
          const left = child.childForFieldName('left');
          const right = child.childForFieldName('right');
          if (left?.type === 'variable_name') {
            const name = left.text.slice(1);
            add(name, child.endIndex, child, () => annotation(child, name) ?? inf.expr(right));
          } else if (left?.type === 'list_literal') {
            destructure(left, () => inf.expr(right), child.endIndex, child);
          }
          break;
        }
        case 'augmented_assignment_expression': {
          const left = child.childForFieldName('left');
          if (left?.type === 'variable_name') add(left.text.slice(1), child.endIndex, child, () => inf.expr(child));
          break;
        }
        case 'foreach_statement': {
          const [iterable, target] = child.namedChildren;
          if (!iterable || !target) break;
          const from = child.childForFieldName('body')?.startIndex ?? child.endIndex;
          const source = () => inf.expr(iterable);
          let value: Node | undefined = target;
          if (target.type === 'pair') {
            const [key, item] = target.namedChildren;
            if (key?.type === 'variable_name') add(key.text.slice(1), from, child, () => ref({ of: 'key', on: source() }));
            value = item;
          }
          if (value?.type === 'by_ref') value = value.namedChildren[0];
          const element = () => ref({ of: 'element', on: source() });
          if (value?.type === 'variable_name') add(value.text.slice(1), from, child, element);
          else if (value?.type === 'list_literal') destructure(value, element, from, child);
          break;
        }
        case 'catch_clause': {
          const variable = child.childForFieldName('name');
          if (!variable) break;
          const scope = inf.scopeOf(child);
          const types = child.childForFieldName('type')?.namedChildren ?? [];
          add(variable.text.slice(1), child.childForFieldName('body')?.startIndex ?? child.endIndex, child, () => union(...types.map((t) => typeFromNode(t, scope))));
          break;
        }
        case 'static_variable_declaration': {
          const variable = child.childForFieldName('name');
          const value = child.childForFieldName('value');
          if (variable) add(variable.text.slice(1), child.endIndex, child, () => (value ? inf.expr(value) : MIXED));
          break;
        }
        case 'global_declaration':
          for (const variable of child.namedChildren) {
            if (variable.type === 'variable_name') add(variable.text.slice(1), child.endIndex, child, () => MIXED);
          }
          break;
        case 'comment':
          if (child.text.startsWith('/**')) {
            for (const entry of docVar(cleanDoc(child.text))) {
              if (entry.name) add(entry.name, child.endIndex, child, () => parseDocType(entry.type, inf.scopeOf(child)) ?? MIXED);
            }
          }
          break;
      }
      visit(child);
    }
  };
  visit(root);
  for (const list of map.values()) list.sort((a, b) => a.from - b.from);
  inf.definitions.set(root.id, map);
  return map;
}

const operatorOf = (node: Node) => node.childForFieldName('operator')?.text.toLowerCase() ?? '';
const isVariable = (node: Node | null | undefined, name: string) => node?.type === 'variable_name' && node.text === `$${name}`;
const firstArgument = (call: Node) => {
  const argument = call.childForFieldName('arguments')?.namedChildren.find((a) => a.type === 'argument');
  return argument?.namedChildren[argument.namedChildren.length - 1];
};
const calledName = (call: Node) => call.childForFieldName('function')?.text.toLowerCase().replace(/^\\/, '');

/** Appels assert(…) d'un bloc, dans l'ordre. */
function assertsOf(inf: Inferrer, block: Node): Node[] {
  const cached = inf.asserts.get(block.id);
  if (cached) return cached;
  const out: Node[] = [];
  for (const statement of block.namedChildren) {
    const call = statement.type === 'expression_statement' ? statement.namedChildren[0] : undefined;
    if (call?.type === 'function_call_expression' && calledName(call) === 'assert') out.push(call);
  }
  inf.asserts.set(block.id, out);
  return out;
}

function narrow(inf: Inferrer, type: TypeExpr, name: string, at: Node, root: Node): TypeExpr {
  const conditions: Node[] = [];
  for (let n: Node = at; n.parent && n.id !== root.id; n = n.parent) {
    const parent = n.parent;
    const is = (field: string) => parent.childForFieldName(field)?.id === n.id;
    if ((parent.type === 'if_statement' || parent.type === 'else_if_clause' || parent.type === 'while_statement') && is('body')) {
      const condition = parent.childForFieldName('condition');
      if (condition) conditions.push(condition);
    } else if (parent.type === 'conditional_expression' && is('body')) {
      const condition = parent.childForFieldName('condition');
      if (condition) conditions.push(condition);
    } else if (parent.type === 'binary_expression' && is('right') && ['&&', 'and'].includes(operatorOf(parent))) {
      const left = parent.childForFieldName('left');
      if (left) conditions.push(left);
    }
    if (parent.type === 'compound_statement' || parent.type === 'program') {
      for (const call of assertsOf(inf, parent)) {
        const argument = call.endIndex <= at.startIndex ? firstArgument(call) : undefined;
        if (argument) conditions.push(argument);
      }
    }
  }
  for (const condition of conditions.reverse()) type = applyCondition(inf, type, condition, name);
  return type;
}

function applyCondition(inf: Inferrer, type: TypeExpr, condition: Node, name: string): TypeExpr {
  switch (condition.type) {
    case 'parenthesized_expression':
      return condition.namedChildren[0] ? applyCondition(inf, type, condition.namedChildren[0], name) : type;
    case 'variable_name':
      return isVariable(condition, name) ? withoutNull(type) : type;
    case 'binary_expression': {
      const operator = operatorOf(condition);
      const left = condition.childForFieldName('left');
      const right = condition.childForFieldName('right');
      if ((operator === '&&' || operator === 'and') && left && right) return applyCondition(inf, applyCondition(inf, type, left, name), right, name);
      if (operator === 'instanceof' && isVariable(left, name)) {
        const target = inf.classOf(right);
        return target.kind === 'mixed' ? type : target;
      }
      const comparesNull = (isVariable(left, name) && right?.type === 'null') || (left?.type === 'null' && isVariable(right, name));
      if (comparesNull && (operator === '!==' || operator === '!=')) return withoutNull(type);
      if (comparesNull && operator === '===') return scalar('null');
      return type;
    }
    case 'unary_op_expression': {
      const inner = condition.namedChildren[0];
      if (operatorOf(condition) === '!' && inner?.type === 'function_call_expression' && calledName(inner) === 'is_null' && isVariable(firstArgument(inner), name)) return withoutNull(type);
      return type;
    }
    case 'function_call_expression': {
      const fn = calledName(condition) ?? '';
      if (!isVariable(firstArgument(condition), name)) return type;
      if (fn === 'isset') return withoutNull(type);
      return Object.hasOwn(TYPE_CHECKS, fn) ? TYPE_CHECKS[fn] : type;
    }
    default:
      return type;
  }
}
