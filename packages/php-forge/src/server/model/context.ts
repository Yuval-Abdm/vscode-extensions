// Contexte syntaxique d'un nœud : classe et fonction englobantes, templates visibles, instructions return.
import type { NameScope } from '../../shared/types.ts';
import type { Node } from '../parser/parser.ts';
import { scopeAt } from './names.ts';
import { docComment, docTemplates } from './phpdoc.ts';
import { rangeOf } from './ranges.ts';

export const CLASS_DECLARATIONS = new Set(['class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration']);
export const FUNCTION_NODES = new Set(['function_definition', 'method_declaration', 'anonymous_function', 'arrow_function']);

export function enclosingClassNode(node: Node): Node | undefined {
  for (let n = node.parent; n; n = n.parent) if (CLASS_DECLARATIONS.has(n.type)) return n;
  return undefined;
}

/** Nom complet de la classe (ou trait, interface, enum) qui contient le nœud. */
export function enclosingClass(node: Node, scopes: NameScope[]): string | undefined {
  const declaration = enclosingClassNode(node);
  const name = declaration?.childForFieldName('name')?.text;
  if (!declaration || !name) return undefined;
  const namespace = scopeAt(scopes, rangeOf(declaration).start).namespace;
  return namespace ? `${namespace}\\${name}` : name;
}

export function enclosingFunction(node: Node): Node | undefined {
  for (let n = node.parent; n; n = n.parent) if (FUNCTION_NODES.has(n.type)) return n;
  return undefined;
}

/** Templates visibles depuis un nœud : ceux de la classe englobante puis de la fonction. */
export function templatesAround(node: Node): string[] {
  const fn = FUNCTION_NODES.has(node.type) ? node : enclosingFunction(node);
  const declaration = enclosingClassNode(node);
  return [...docTemplates(declaration ? docComment(declaration) : undefined), ...docTemplates(fn ? docComment(fn) : undefined)];
}

/** Parcourt un corps de fonction sans entrer dans les fonctions ni les classes imbriquées. */
function* ownNodes(body: Node): Generator<Node> {
  for (const child of body.namedChildren) {
    if (FUNCTION_NODES.has(child.type) || CLASS_DECLARATIONS.has(child.type) || child.type === 'anonymous_class') continue;
    yield child;
    yield* ownNodes(child);
  }
}

export function returnStatements(body: Node): Node[] {
  return [...ownNodes(body)].filter((n) => n.type === 'return_statement');
}

export function containsYield(body: Node): boolean {
  for (const n of ownNodes(body)) if (n.type === 'yield_expression') return true;
  return false;
}
