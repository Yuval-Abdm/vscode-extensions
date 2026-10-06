// Types écrits dans le code (paramètres, retours, propriétés, constantes) → TypeExpr.
import type { NameScope, ScalarName, TypeExpr } from '../../shared/types.ts';
import { resolveClassName } from '../model/names.ts';
import type { Node } from '../parser/parser.ts';
import { classType, MIXED, scalar, union } from './type.ts';

const SCALARS: Record<string, ScalarName> = {
  int: 'int', integer: 'int', float: 'float', double: 'float', string: 'string', bool: 'bool', boolean: 'bool',
  true: 'true', false: 'false', null: 'null', void: 'void', never: 'never', resource: 'resource',
  callable: 'callable', iterable: 'iterable', object: 'object',
};

/** Nom de type simple (déclaré ou phpdoc) : scalaire, array, mixed, self / static / parent / $this ou classe. */
export function simpleType(name: string, scope: NameScope): TypeExpr | undefined {
  const lower = name.toLowerCase();
  if (Object.hasOwn(SCALARS, lower)) return scalar(SCALARS[lower]);
  switch (lower) {
    case 'array':
      return { kind: 'array' };
    case 'mixed':
      return MIXED;
    case 'self':
      return { kind: 'self' };
    case 'static':
    case '$this':
      return { kind: 'static' };
    case 'parent':
      return { kind: 'parent' };
  }
  const fqn = resolveClassName(name, scope);
  return fqn ? classType(fqn) : undefined;
}

export function typeFromNode(node: Node | null | undefined, scope: NameScope): TypeExpr | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case 'primitive_type':
    case 'named_type':
      return simpleType(node.text.replace(/\s+/g, ''), scope);
    case 'optional_type': {
      const inner = typeFromNode(node.namedChildren[0], scope);
      return inner && union(inner, scalar('null'));
    }
    case 'union_type':
    case 'disjunctive_normal_form_type':
      return union(...node.namedChildren.map((c) => typeFromNode(c, scope)));
    case 'intersection_type': {
      const types = node.namedChildren.map((c) => typeFromNode(c, scope)).filter((t): t is TypeExpr => !!t);
      return types.length ? { kind: 'intersection', types } : undefined;
    }
    default:
      return undefined;
  }
}
