// Ce que désigne la position du curseur : classe, fonction, constante ou membre (avec son propriétaire).
import type { Position } from '../../shared/types.ts';
import type { Node, Tree } from '../parser/parser.ts';

export type MemberKind = 'method' | 'property' | 'classConstant';

/** Propriétaire d'un membre : classe nommée, classe englobante (self / static / $this), son parent, une expression typable, ou inconnu. */
export type Owner =
  | { kind: 'class'; name: string }
  | { kind: 'self' }
  | { kind: 'parent' }
  | { kind: 'expression'; node: Node }
  | { kind: 'unknown' };

export type Reference =
  | { kind: 'class' | 'function' | 'constant'; name: string; node: Node }
  | { kind: 'member'; member: MemberKind; name: string; owner: Owner; node: Node };

const NAME_TYPES = new Set(['name', 'qualified_name', 'relative_name']);
const NAME_PARTS = new Set(['qualified_name', 'relative_name', 'namespace_name']);
const CLASS_CONTEXTS = new Set([
  'object_creation_expression', 'base_clause', 'class_interface_clause', 'named_type', 'use_declaration', 'attribute',
  'class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration',
]);
const NOT_A_CONSTANT = new Set(['named_label_statement', 'goto_statement', 'declare_directive', 'namespace_definition']);

const NAME_LIKE = new Set([...NAME_TYPES, 'namespace_name', 'variable_name']);

export function nameAt(tree: Tree, pos: Position): Reference | undefined {
  const at = (character: number) => tree.rootNode.namedDescendantForPosition({ row: pos.line, column: character });
  let node: Node | null = at(pos.character);
  // Curseur juste après un nom (« new Foo|() ») : comme VS Code, on prend le mot qui se termine là
  if (node && !NAME_LIKE.has(node.type) && pos.character > 0) {
    const previous = at(pos.character - 1);
    if (previous && NAME_LIKE.has(previous.type)) node = previous;
  }
  if (!node) return undefined;
  if (node.type === 'name' && node.parent?.type === 'variable_name') node = node.parent;
  if (node.type === 'variable_name') return propertyAt(node);
  if (!NAME_TYPES.has(node.type) && node.type !== 'namespace_name') return undefined;
  while (node.parent && NAME_PARTS.has(node.parent.type)) node = node.parent;
  if (node.type === 'namespace_name') return undefined; // nom de namespace (déclaration, préfixe de groupe)
  const parent = node.parent;
  if (!parent) return undefined;

  const name = node.text.replace(/\s+/g, '');
  const field = fieldOf(node);
  const cls: Reference = { kind: 'class', name, node };
  const member = (kind: MemberKind, owner: Owner): Reference => ({ kind: 'member', member: kind, name, owner, node });

  switch (parent.type) {
    case 'function_call_expression':
      return field === 'function' ? { kind: 'function', name, node } : undefined;
    case 'function_definition':
      return field === 'name' ? { kind: 'function', name, node } : undefined;
    case 'scoped_call_expression':
      return field === 'scope' ? cls : member('method', staticOwner(parent.childForFieldName('scope')));
    case 'scoped_property_access_expression':
      return field === 'scope' ? cls : undefined;
    case 'class_constant_access_expression': {
      const scope = parent.namedChildren[0];
      return scope.id === node.id ? cls : member('classConstant', staticOwner(scope));
    }
    case 'member_call_expression':
    case 'nullsafe_member_call_expression':
      return field === 'name' ? member('method', instanceOwner(parent.childForFieldName('object'))) : undefined;
    case 'member_access_expression':
    case 'nullsafe_member_access_expression':
      return field === 'name' ? member('property', instanceOwner(parent.childForFieldName('object'))) : undefined;
    case 'method_declaration':
      return field === 'name' ? member('method', { kind: 'self' }) : undefined;
    case 'const_element':
      return insideClass(parent) ? member('classConstant', { kind: 'self' }) : { kind: 'constant', name, node };
    case 'enum_case':
      return member('classConstant', { kind: 'self' });
    case 'binary_expression':
      return isInstanceofTarget(parent, node) ? cls : { kind: 'constant', name, node };
    case 'argument':
      return field === 'name' ? undefined : { kind: 'constant', name, node };
    case 'namespace_use_clause':
      return field === 'alias' ? undefined : useTarget(parent, name, node);
  }
  if (CLASS_CONTEXTS.has(parent.type)) return cls;
  if (NOT_A_CONSTANT.has(parent.type)) return undefined;
  return { kind: 'constant', name, node };
}

function fieldOf(node: Node): string | null {
  const parent = node.parent!;
  for (let i = 0; i < parent.childCount; i++) if (parent.child(i)?.id === node.id) return parent.fieldNameForChild(i);
  return null;
}

/** `$prop` dans `A::$prop` ou dans une déclaration de propriété. */
function propertyAt(variable: Node): Reference | undefined {
  const parent = variable.parent;
  const name = variable.text.slice(1);
  if (parent?.type === 'scoped_property_access_expression' && fieldOf(variable) === 'name') {
    return { kind: 'member', member: 'property', name, owner: staticOwner(parent.childForFieldName('scope')), node: variable };
  }
  if (parent?.type === 'property_element' || parent?.type === 'property_promotion_parameter') {
    return { kind: 'member', member: 'property', name, owner: { kind: 'self' }, node: variable };
  }
  return undefined;
}

function staticOwner(scope: Node | null): Owner {
  if (!scope) return { kind: 'unknown' };
  const text = scope.text.replace(/\s+/g, '');
  const lower = text.toLowerCase();
  if (lower === 'self' || lower === 'static') return { kind: 'self' };
  if (lower === 'parent') return { kind: 'parent' };
  return NAME_TYPES.has(scope.type) ? { kind: 'class', name: text } : { kind: 'expression', node: scope };
}

function instanceOwner(object: Node | null): Owner {
  if (!object) return { kind: 'unknown' };
  return object.type === 'variable_name' && object.text === '$this' ? { kind: 'self' } : { kind: 'expression', node: object };
}

function insideClass(node: Node): boolean {
  for (let n = node.parent; n; n = n.parent) {
    if (n.type === 'declaration_list' || n.type === 'enum_declaration_list') return true;
    if (n.type === 'function_definition' || n.type === 'program') return false;
  }
  return false;
}

function isInstanceofTarget(binary: Node, node: Node): boolean {
  return binary.childForFieldName('right')?.id === node.id && binary.children.some((c) => c.type === 'instanceof');
}

/** Cible d'un `use` : toujours un nom complet (préfixe de groupe compris) ; `use function` / `use const`. */
function useTarget(clause: Node, name: string, node: Node): Reference {
  const group = clause.parent?.type === 'namespace_use_group' ? clause.parent : undefined;
  const declaration = (group ?? clause).parent;
  const prefix = group ? declaration?.namedChildren.find((c) => c.type === 'namespace_name')?.text.replace(/\s+/g, '') : undefined;
  const full = `\\${prefix ? `${prefix}\\` : ''}${name.replace(/^\\/, '')}`;
  const keyword = [clause, declaration].flatMap((n) => n?.children ?? []).find((c) => !c.isNamed && (c.type === 'function' || c.type === 'const'))?.type;
  return { kind: keyword === 'function' ? 'function' : keyword === 'const' ? 'constant' : 'class', name: full, node };
}

const NOT_A_VARIABLE = new Set(['scoped_property_access_expression', 'property_element', 'property_promotion_parameter']);

/** Variable sous le curseur (ou juste avant), hors propriétés `A::$x` et déclarations de propriétés. */
export function variableAt(tree: Tree, pos: Position): Node | undefined {
  const at = (character: number): Node | undefined => {
    let node: Node | null = tree.rootNode.namedDescendantForPosition({ row: pos.line, column: character });
    if (node?.type === 'name' && node.parent?.type === 'variable_name') node = node.parent;
    return node?.type === 'variable_name' ? node : undefined;
  };
  const node = at(pos.character) ?? (pos.character > 0 ? at(pos.character - 1) : undefined);
  if (!node || NOT_A_VARIABLE.has(node.parent?.type ?? '')) return undefined;
  return node;
}
