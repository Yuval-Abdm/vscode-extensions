// Tokens sémantiques : namespaces, classes / interfaces / enums / traits, fonctions, méthodes, propriétés,
// constantes et paramètres, avec les modificateurs declaration, static, readonly, deprecated, abstract et
// defaultLibrary (fonctions et classes natives de PHP).
import type { FileSymbols } from '../../shared/types.ts';
import type { Lookup } from '../index/lookup.ts';
import type { IndexedSymbol } from '../index/symbolIndex.ts';
import { CLASS_DECLARATIONS, FUNCTION_NODES } from '../model/context.ts';
import { resolveClassName, resolveFunctionOrConstant, scopeAt } from '../model/names.ts';
import { rangeOf } from '../model/ranges.ts';
import type { Node, Tree } from '../parser/parser.ts';
import { scopeRoot } from '../types/flow.ts';
import { nameAt } from './nameAt.ts';

export const TOKEN_TYPES = ['namespace', 'class', 'interface', 'enum', 'type', 'parameter', 'variable', 'property', 'enumMember', 'function', 'method'] as const;
export const TOKEN_MODIFIERS = ['declaration', 'static', 'readonly', 'deprecated', 'abstract', 'defaultLibrary'] as const;
type TokenType = (typeof TOKEN_TYPES)[number];
type TokenModifier = (typeof TOKEN_MODIFIERS)[number];

interface Token {
  line: number;
  character: number;
  length: number;
  type: TokenType;
  modifiers: TokenModifier[];
}

const CLASS_TOKENS: Record<string, TokenType> = { class: 'class', interface: 'interface', enum: 'enum', trait: 'type' };
const DECLARATIONS = new Set([...CLASS_DECLARATIONS, 'function_definition', 'method_declaration', 'enum_case']);
const PARAMETERS = new Set(['simple_parameter', 'variadic_parameter', 'property_promotion_parameter']);

export function semanticTokens(lookup: Lookup, file: FileSymbols, tree: Tree): number[] {
  const tokens: Token[] = [];
  const cache = new Map<string, IndexedSymbol | undefined>();
  const parameters = new Map<number, Set<string>>();

  const push = (node: Node, type: TokenType, modifiers: TokenModifier[]) => {
    if (node.startPosition.row !== node.endPosition.row) return;
    tokens.push({ line: node.startPosition.row, character: node.startPosition.column, length: node.endIndex - node.startIndex, type, modifiers });
  };
  const flags = (hit: IndexedSymbol | undefined, modifiers: TokenModifier[]): TokenModifier[] => {
    const out = [...modifiers];
    if (hit?.symbol.deprecated) out.push('deprecated');
    if (hit?.uri.startsWith('phpstub:')) out.push('defaultLibrary');
    return out;
  };
  const cached = (key: string, find: () => IndexedSymbol | undefined) => {
    if (!cache.has(key)) cache.set(key, find());
    return cache.get(key);
  };
  const first = (names: string[], find: (name: string) => IndexedSymbol[]) => {
    for (const name of names) {
      const hit = find(name)[0];
      if (hit) return hit;
    }
    return undefined;
  };
  const scopeOf = (node: Node) => scopeAt(file.scopes, rangeOf(node).start);
  const isDeclaration = (node: Node) => {
    const parent = node.parent;
    if (!parent) return false;
    if (parent.type === 'const_element') return parent.namedChildren[0]?.id === node.id;
    return DECLARATIONS.has(parent.type) && parent.childForFieldName('name')?.id === node.id;
  };
  const parametersOf = (fn: Node) => {
    let names = parameters.get(fn.id);
    if (!names) {
      names = new Set(
        (fn.childForFieldName('parameters')?.namedChildren ?? [])
          .filter((p) => PARAMETERS.has(p.type))
          .map((p) => p.childForFieldName('name')?.text.slice(1) ?? ''),
      );
      parameters.set(fn.id, names);
    }
    return names;
  };

  const name = (node: Node): void => {
    const parent = node.parent;
    if (!parent || parent.type === 'variable_name') return;
    if (parent.type === 'namespace_name') return push(node, 'namespace', []);
    const ref = nameAt(tree, { line: node.startPosition.row, character: node.startPosition.column });
    if (!ref) return;
    const modifiers: TokenModifier[] = isDeclaration(node) ? ['declaration'] : [];
    switch (ref.kind) {
      case 'class': {
        if (['self', 'static', 'parent'].includes(ref.name.toLowerCase())) return;
        const fqn = resolveClassName(ref.name, scopeOf(node));
        const hit = fqn ? cached(`c:${fqn.toLowerCase()}`, () => lookup.findClass(fqn)[0]) : undefined;
        if (hit?.symbol.modifiers?.includes('abstract')) modifiers.push('abstract');
        return push(node, CLASS_TOKENS[hit?.symbol.kind ?? 'class'] ?? 'class', flags(hit, modifiers));
      }
      case 'function': {
        const names = resolveFunctionOrConstant(ref.name, 'function', scopeOf(node));
        return push(node, 'function', flags(cached(`f:${names.join('|').toLowerCase()}`, () => first(names, (n) => lookup.findFunction(n))), modifiers));
      }
      case 'constant': {
        const names = resolveFunctionOrConstant(ref.name, 'constant', scopeOf(node));
        return push(node, 'variable', flags(cached(`k:${names.join('|')}`, () => first(names, (n) => lookup.findConstant(n))), [...modifiers, 'readonly']));
      }
      case 'member':
        if (ref.member === 'method') {
          const isStatic = parent.type === 'scoped_call_expression' || (parent.type === 'method_declaration' && parent.namedChildren.some((c) => c.type === 'static_modifier'));
          return push(node, 'method', isStatic ? [...modifiers, 'static'] : modifiers);
        }
        if (ref.member === 'classConstant') {
          if (ref.name.toLowerCase() === 'class') return;
          return parent.type === 'enum_case' ? push(node, 'enumMember', modifiers) : push(node, 'property', [...modifiers, 'static', 'readonly']);
        }
        return push(node, 'property', modifiers);
    }
  };

  const variable = (node: Node): void => {
    const variableName = node.text.slice(1);
    if (variableName === 'this') return;
    const parent = node.parent;
    if (parent?.type === 'property_element' || parent?.type === 'property_promotion_parameter') {
      const declaration = parent.type === 'property_element' ? parent.parent : parent;
      const isStatic = declaration?.namedChildren.some((c) => c.type === 'static_modifier') ?? false;
      return push(node, 'property', isStatic ? ['declaration', 'static'] : ['declaration']);
    }
    if (parent?.type === 'scoped_property_access_expression') return push(node, 'property', ['static']);
    const root = scopeRoot(node);
    if (!FUNCTION_NODES.has(root.type) || !parametersOf(root).has(variableName)) return;
    push(node, 'parameter', parent?.type === 'simple_parameter' || parent?.type === 'variadic_parameter' ? ['declaration'] : []);
  };

  const cursor = tree.walk();
  for (;;) {
    const type = cursor.nodeType;
    if (type === 'name') name(cursor.currentNode);
    else if (type === 'variable_name') variable(cursor.currentNode);
    if (cursor.gotoFirstChild()) continue;
    let done = false;
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent()) {
        done = true;
        break;
      }
    }
    if (done) break;
  }
  cursor.delete();

  tokens.sort((a, b) => a.line - b.line || a.character - b.character);
  const data: number[] = [];
  let line = 0;
  let character = 0;
  for (const token of tokens) {
    const deltaLine = token.line - line;
    data.push(
      deltaLine,
      deltaLine === 0 ? token.character - character : token.character,
      token.length,
      TOKEN_TYPES.indexOf(token.type),
      token.modifiers.reduce((bits, m) => bits | (1 << TOKEN_MODIFIERS.indexOf(m)), 0),
    );
    line = token.line;
    character = token.character;
  }
  return data;
}
