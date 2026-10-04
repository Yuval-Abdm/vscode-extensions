// Contexte de complétion : le document est ré-analysé avec un identifiant factice au curseur, ce qui donne un
// arbre complet même pendant la frappe (« $obj-> » devient « $obj->PhpForgeCursor ») ; le nœud qui contient
// cet identifiant dit quoi proposer.
import { parsePhp, type Node, type Parser, type Tree } from '../parser/parser.ts';

export const PLACEHOLDER = 'PhpForgeCursor';

export type NameMode = 'any' | 'class' | 'new' | 'type' | 'use';

export type CompletionContext =
  | { kind: 'none' }
  | { kind: 'variable'; prefix: string; node: Node }
  | { kind: 'member'; prefix: string; object: Node; node: Node }
  | { kind: 'static'; prefix: string; scope: Node; node: Node; variable: boolean }
  | { kind: 'name'; prefix: string; node: Node; mode: NameMode }
  | { kind: 'include'; prefix: string; node: Node }
  | { kind: 'arrayKey'; prefix: string; target: Node; node: Node }
  | { kind: 'docTag'; prefix: string };

const NONE: CompletionContext = { kind: 'none' };
const NAME_PARTS = new Set(['qualified_name', 'relative_name', 'namespace_name']);
const INCLUDES = new Set(['include_expression', 'include_once_expression', 'require_expression', 'require_once_expression']);
const MEMBER_ACCESS = new Set(['member_access_expression', 'nullsafe_member_access_expression', 'member_call_expression', 'nullsafe_member_call_expression']);
const CLASS_PARENTS = new Set(['base_clause', 'class_interface_clause', 'attribute', 'use_declaration']);
const TYPE_PARENTS = new Set(['named_type', 'type_list']);
const DECLARATIONS = new Set([
  'class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration', 'function_definition',
  'method_declaration', 'const_element', 'enum_case', 'namespace_definition', 'named_label_statement', 'goto_statement',
]);
const PARAMETERS = new Set(['property_element', 'simple_parameter', 'variadic_parameter', 'property_promotion_parameter']);

export function completionContext(parser: Parser, text: string, offset: number): { tree: Tree; context: CompletionContext } {
  // Accolades pas encore fermées (fonction en cours d'écriture) : fermées à la fin du document, sans
  // décaler les positions avant le curseur, pour que la fonction et ses paramètres existent dans l'arbre
  const patched = text.slice(0, offset) + PLACEHOLDER + text.slice(offset) + '}'.repeat(unclosedBraces(text));
  const tree = parsePhp(parser, patched);
  return { tree, context: classify(tree, patched, offset) };
}

/** Accolades ouvertes non fermées dans les blocs PHP, hors chaînes et commentaires. */
export function unclosedBraces(text: string): number {
  let depth = 0;
  let php = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!php) {
      if (c === '<' && text[i + 1] === '?') {
        php = true;
        i++;
      }
      continue;
    }
    if (c === '?' && text[i + 1] === '>') {
      php = false;
      i++;
    } else if (c === "'" || c === '"') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else if ((c === '/' && text[i + 1] === '/') || c === '#') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
    } else if (c === '{') depth++;
    else if (c === '}' && depth > 0) depth--;
  }
  return depth;
}

function fieldOf(node: Node): string | null {
  const parent = node.parent;
  if (!parent) return null;
  for (let i = 0; i < parent.childCount; i++) if (parent.child(i)?.id === node.id) return parent.fieldNameForChild(i);
  return null;
}

function ancestor(node: Node, test: (n: Node) => boolean): Node | undefined {
  for (let n: Node | null = node; n; n = n.parent) if (test(n)) return n;
  return undefined;
}

function classify(tree: Tree, text: string, offset: number): CompletionContext {
  const node = tree.rootNode.descendantForIndex(offset, offset + PLACEHOLDER.length);
  if (!node) return NONE;

  if (node.type === 'comment') {
    const tag = /@([\w-]*)$/.exec(text.slice(node.startIndex, offset));
    return node.text.startsWith('/**') && tag ? { kind: 'docTag', prefix: tag[1] } : NONE;
  }

  const string = ancestor(node, (n) => n.type === 'string' || n.type === 'encapsed_string');
  if (string) {
    const prefix = text.slice(string.startIndex + 1, offset);
    if (ancestor(string, (n) => INCLUDES.has(n.type))) return { kind: 'include', prefix, node: string };
    const parent = string.parent;
    if (parent?.type === 'subscript_expression' && parent.namedChildren[1]?.id === string.id) {
      return { kind: 'arrayKey', prefix, target: parent.namedChildren[0], node: string };
    }
    return NONE;
  }

  if (node.type !== 'name') return NONE;
  const at = node.text.indexOf(PLACEHOLDER);
  if (at < 0) return NONE;
  const prefix = node.text.slice(0, at);
  const parent = node.parent;
  if (!parent) return NONE;

  if (parent.type === 'variable_name') {
    const grand = parent.parent;
    if (grand?.type === 'scoped_property_access_expression' && grand.childForFieldName('name')?.id === parent.id) {
      const scope = grand.childForFieldName('scope');
      return scope ? { kind: 'static', prefix, scope, node: parent, variable: true } : NONE;
    }
    if (grand && PARAMETERS.has(grand.type)) return NONE;
    return { kind: 'variable', prefix, node: parent };
  }
  if (MEMBER_ACCESS.has(parent.type)) {
    const object = parent.childForFieldName('object');
    return fieldOf(node) === 'name' && object ? { kind: 'member', prefix, object, node } : NONE;
  }
  if (parent.type === 'scoped_call_expression' && fieldOf(node) === 'name') {
    const scope = parent.childForFieldName('scope');
    return scope ? { kind: 'static', prefix, scope, node, variable: false } : NONE;
  }
  if (parent.type === 'class_constant_access_expression' && parent.namedChildren[1]?.id === node.id) {
    return { kind: 'static', prefix, scope: parent.namedChildren[0], node, variable: false };
  }

  let name: Node = node;
  while (name.parent && NAME_PARTS.has(name.parent.type)) name = name.parent;
  const owner = name.parent;
  // Identifiant seul sur sa ligne : tree-sitter y voit un label « nom: » dont le « : » manque
  const typing = owner?.type === 'named_label_statement' && owner.children.some((c) => c.isMissing);
  if (!owner || name.type === 'namespace_name' || (DECLARATIONS.has(owner.type) && !typing)) return NONE;
  const full = text.slice(name.startIndex, offset);
  if (owner.type === 'object_creation_expression') return { kind: 'name', prefix: full, node: name, mode: 'new' };
  if (owner.type === 'namespace_use_clause') return fieldOf(name) === 'alias' ? NONE : { kind: 'name', prefix: full, node: name, mode: 'use' };
  if (TYPE_PARENTS.has(owner.type)) return { kind: 'name', prefix: full, node: name, mode: 'type' };
  if (CLASS_PARENTS.has(owner.type)) return { kind: 'name', prefix: full, node: name, mode: 'class' };
  if (owner.type === 'binary_expression' && owner.childForFieldName('right')?.id === name.id && owner.childForFieldName('operator')?.text === 'instanceof') {
    return { kind: 'name', prefix: full, node: name, mode: 'class' };
  }
  return { kind: 'name', prefix: full, node: name, mode: 'any' };
}
