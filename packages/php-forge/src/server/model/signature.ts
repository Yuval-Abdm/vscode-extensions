// Signatures lisibles (survol, aide) construites depuis l'arbre : espaces normalisés, attributs retirés.
import type { Node } from '../parser/parser.ts';

export const squash = (s: string): string => s.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();

export const truncate = (s: string, max = 80): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function modifiersOf(node: Node): string[] {
  return node.namedChildren.filter((c) => c.type.endsWith('_modifier') && c.type !== 'reference_modifier').map((c) => c.text.toLowerCase());
}

/** Texte d'un nœud sans ses attributs `#[…]` directs. */
export function withoutAttributes(node: Node): string {
  let text = node.text;
  for (const attributes of node.namedChildren.filter((c) => c.type === 'attribute_list')) text = text.replace(attributes.text, '');
  return squash(text);
}

export function functionSignature(node: Node): string {
  const name = node.childForFieldName('name')!.text;
  const parameters = node.childForFieldName('parameters')?.namedChildren.filter((p) => p.type !== 'comment').map(withoutAttributes) ?? [];
  const returnType = node.childForFieldName('return_type');
  const reference = node.children.some((c) => c.type === 'reference_modifier') ? '&' : '';
  const head = [...modifiersOf(node), 'function'].join(' ');
  return squash(`${head} ${reference}${name}(${parameters.join(', ')})${returnType ? `: ${returnType.text}` : ''}`);
}

export function classSignature(node: Node, keyword: string): string {
  let text = [...modifiersOf(node), keyword, node.childForFieldName('name')!.text].join(' ');
  for (const child of node.namedChildren) {
    if (child.type === 'primitive_type') text += `: ${child.text}`;
    else if (child.type === 'base_clause' || child.type === 'class_interface_clause') text += ` ${child.text}`;
  }
  return squash(text);
}

export function propertySignature(declaration: Node, element: Node): string {
  const type = declaration.childForFieldName('type')?.text;
  const name = element.childForFieldName('name')!.text;
  const value = element.childForFieldName('default_value')?.text;
  return squash([...modifiersOf(declaration), type, value ? `${name} = ${truncate(value)}` : name].filter(Boolean).join(' '));
}

export function constSignature(declaration: Node, element: Node): string {
  const [name, value] = element.namedChildren;
  return squash([...modifiersOf(declaration), 'const', `${name.text} = ${truncate(value?.text ?? '')}`].join(' '));
}
