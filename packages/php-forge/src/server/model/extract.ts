// Arbre tree-sitter → résumé sérialisable d'un fichier : portées de noms, déclarations typées, inclusions.
// Une requête tree-sitter (exécutée en WASM) repère les nœuds utiles, traités dans l'ordre du fichier.
import { Query } from 'web-tree-sitter';
import type { FileSymbols, IncludeKind, NameScope, PhpParam, PhpSymbol, SymbolKind, TypeExpr } from '../../shared/types.ts';
import { getLanguage, type Node, type Tree } from '../parser/parser.ts';
import { typeFromNode } from '../types/declType.ts';
import { parseDocType } from '../types/docType.ts';
import { levelTypeAware, parametersOf, pickType } from '../types/params.ts';
import { newScope, resolveClassName, scopeAt } from './names.ts';
import { docComment, docMethods, docMixins, docParents, docProperties, docReturn, docTag, docTemplates, docVar } from './phpdoc.ts';
import { rangeOf } from './ranges.ts';
import { classSignature, constSignature, functionSignature, modifiersOf, propertySignature, squash, truncate, withoutAttributes } from './signature.ts';

const PATTERNS = `
(namespace_definition) @namespace
(namespace_use_declaration) @use
[(class_declaration) (interface_declaration) (trait_declaration) (enum_declaration)] @class
(function_definition) @function
(const_declaration) @const
[(include_expression) (include_once_expression) (require_expression) (require_once_expression)] @include
(function_call_expression function: (name) @fn (#match? @fn "^[dD][eE][fF][iI][nN][eE]$")) @define
`;

const CLASS_KINDS: Record<string, SymbolKind> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  trait_declaration: 'trait',
  enum_declaration: 'enum',
};

const INCLUDE_KINDS: Record<string, IncludeKind> = {
  include_expression: 'include',
  include_once_expression: 'include_once',
  require_expression: 'require',
  require_once_expression: 'require_once',
};

const NAME_TYPES = new Set(['name', 'qualified_name', 'relative_name']);
const MEMBER_LISTS = new Set(['declaration_list', 'enum_declaration_list']);

let query: Query | undefined;

export function extractFile(tree: Tree, uri: string): FileSymbols {
  const root = tree.rootNode;
  const fileEnd = rangeOf(root).end;
  const fileScope = newScope('', rangeOf(root));
  const out: FileSymbols = { uri, symbols: [], includes: [], scopes: [fileScope], syntaxError: root.hasError };
  let open = fileScope; // portée ouverte par `namespace X;` (au départ : celle du fichier)
  query ??= new Query(getLanguage(), PATTERNS);

  for (const { name, node } of query.captures(root)) {
    const start = rangeOf(node).start;
    if (name === 'namespace') {
      const namespace = clean(node.childForFieldName('name')?.text ?? '');
      if (node.childForFieldName('body')) {
        out.scopes.push(newScope(namespace, rangeOf(node)));
      } else {
        open.range = { start: open.range.start, end: start };
        open = newScope(namespace, { start, end: fileEnd });
        out.scopes.push(open);
      }
      continue;
    }
    const scope = scopeAt(out.scopes, start);
    switch (name) {
      case 'use':
        addUses(scope, node);
        break;
      case 'class':
        out.symbols.push(classSymbol(node, scope));
        break;
      case 'function':
        out.symbols.push(functionSymbol(node, scope));
        break;
      case 'const':
        if (!MEMBER_LISTS.has(node.parent?.type ?? '')) out.symbols.push(...constSymbols(node, scope, true));
        break;
      case 'include': {
        let path = node.namedChildren[0];
        if (path?.type === 'parenthesized_expression') path = path.namedChildren[0];
        out.includes.push({ kind: INCLUDE_KINDS[node.type], range: rangeOf(node), expression: path ? squash(path.text) : '' });
        break;
      }
      case 'define': {
        const symbol = defineSymbol(node);
        if (symbol) out.symbols.push(symbol);
        break;
      }
    }
  }
  return out;
}

const clean = (s: string) => s.replace(/\s+/g, '').replace(/^\\/, '');
const qualify = (scope: NameScope, name: string) => (scope.namespace ? `${scope.namespace}\\${name}` : name);
const childOfType = (node: Node, type: string) => node.namedChildren.find((c) => c.type === type);

/** Noms de classes listés sous un nœud (extends, implements, use de trait), résolus. */
function classNames(node: Node | undefined, scope: NameScope): string[] {
  return (node?.namedChildren ?? [])
    .filter((c) => NAME_TYPES.has(c.type))
    .map((c) => resolveClassName(c.text, scope))
    .filter((n): n is string => !!n);
}

/** Mot-clé `function` / `const` d'un `use` (enfant anonyme de la déclaration ou de la clause). */
function keywordOf(node: Node): 'function' | 'const' | undefined {
  for (const child of node.children) if (!child.isNamed && (child.type === 'function' || child.type === 'const')) return child.type;
  return undefined;
}

function addUses(scope: NameScope, node: Node): void {
  const group = node.childForFieldName('body');
  const prefix = group ? clean(childOfType(node, 'namespace_name')?.text ?? '') : '';
  const declared = keywordOf(node);
  for (const clause of (group ?? node).namedChildren) {
    if (clause.type !== 'namespace_use_clause') continue;
    const target = clause.namedChildren.find((c) => c.type === 'qualified_name' || c.type === 'name');
    if (!target) continue;
    const fqn = clean(prefix ? `${prefix}\\${target.text}` : target.text);
    const alias = clause.childForFieldName('alias')?.text ?? fqn.slice(fqn.lastIndexOf('\\') + 1);
    const kind = keywordOf(clause) ?? declared;
    if (kind === 'function') scope.uses.function[alias.toLowerCase()] = fqn;
    else if (kind === 'const') scope.uses.constant[alias] = fqn;
    else scope.uses.class[alias.toLowerCase()] = fqn;
  }
}

/** Symbole de base : positions, signature, doc, modificateurs et versions (doc et attributs du nœud `owner`). */
function declare(kind: SymbolKind, name: string, node: Node, nameNode: Node, signature: string, owner: Node = node): PhpSymbol {
  const symbol: PhpSymbol = { kind, name, range: rangeOf(node), selectionRange: rangeOf(nameNode), signature };
  const doc = docComment(owner);
  if (doc) symbol.doc = doc;
  const modifiers = modifiersOf(owner);
  if (modifiers.length) symbol.modifiers = modifiers;
  versionInfo(symbol, doc, owner.childForFieldName('attributes')?.text ?? '');
  return symbol;
}

const versionOf = (text: string | undefined) => (text ? /\d+(?:\.\d+)*/.exec(text)?.[0] : undefined);

function versionInfo(symbol: PhpSymbol, doc: string | undefined, attributes: string): void {
  if (/^@deprecated\b/m.test(doc ?? '') || /\bDeprecated\b/.test(attributes)) symbol.deprecated = true;
  const available = /PhpStormStubsElementAvailable\s*\(([^)]*)\)/.exec(attributes)?.[1];
  const from = available ? (/from:\s*['"]([\d.]+)/.exec(available)?.[1] ?? /^\s*['"]([\d.]+)/.exec(available)?.[1]) : undefined;
  const to = available ? /to:\s*['"]([\d.]+)/.exec(available)?.[1] : undefined;
  const since = from ?? versionOf(docTag(doc, 'since'));
  const removed = versionOf(docTag(doc, 'removed'));
  if (since) symbol.since = since;
  if (to) symbol.until = to;
  if (removed) symbol.removed = removed;
}

function classSymbol(node: Node, scope: NameScope): PhpSymbol {
  const kind = CLASS_KINDS[node.type];
  const nameNode = node.childForFieldName('name')!;
  const symbol = declare(kind, nameNode.text, node, nameNode, classSignature(node, kind));
  symbol.fqn = qualify(scope, nameNode.text);
  const templates = docTemplates(symbol.doc);
  if (templates.length) symbol.templates = templates;
  const parents = classNames(childOfType(node, 'base_clause'), scope);
  const interfaces = classNames(childOfType(node, 'class_interface_clause'), scope);
  if (kind === 'enum') interfaces.push(node.namedChildren.some((c) => c.type === 'primitive_type') ? 'BackedEnum' : 'UnitEnum');
  if (parents.length) symbol.extends = parents;
  if (interfaces.length) symbol.implements = interfaces;
  const parentArgs: Record<string, TypeExpr[]> = {};
  for (const text of docParents(symbol.doc)) {
    const type = parseDocType(text, scope, templates);
    if (type?.kind === 'class' && type.args) parentArgs[type.fqn.toLowerCase()] = type.args;
  }
  if (Object.keys(parentArgs).length) symbol.parentArgs = parentArgs;
  const mixins = docMixins(symbol.doc)
    .map((name) => resolveClassName(name.replace(/<.*$/, ''), scope))
    .filter((name): name is string => !!name);
  if (mixins.length) symbol.mixins = mixins;

  const children: PhpSymbol[] = [];
  const traits: string[] = [];
  for (const member of node.childForFieldName('body')?.namedChildren ?? []) {
    if (member.type === 'method_declaration') children.push(...methodSymbols(member, scope, templates));
    else if (member.type === 'property_declaration') children.push(...propertySymbols(member, scope, templates));
    else if (member.type === 'const_declaration') children.push(...constSymbols(member, scope, false));
    else if (member.type === 'use_declaration') traits.push(...classNames(member, scope));
    else if (member.type === 'enum_case') children.push(enumCaseSymbol(member));
  }
  children.push(...virtualMembers(symbol, scope, templates));
  if (traits.length) symbol.uses = traits;
  if (children.length) symbol.children = children;
  return symbol;
}

/** Type de retour : déclaré (ou attribut des stubs) complété par @return. */
function returnType(node: Node, doc: string | undefined, scope: NameScope, templates: string[]): TypeExpr | undefined {
  const declared = typeFromNode(node.childForFieldName('return_type'), scope) ?? levelTypeAware(node, scope, templates);
  const documented = docReturn(doc);
  return pickType(declared, documented ? parseDocType(documented, scope, templates) : undefined);
}

function methodSymbols(node: Node, scope: NameScope, classTemplates: string[]): PhpSymbol[] {
  const nameNode = node.childForFieldName('name')!;
  const method = declare('method', nameNode.text, node, nameNode, functionSignature(node));
  const own = docTemplates(method.doc);
  if (own.length) method.templates = own;
  const templates = [...classTemplates, ...own];
  method.params = parametersOf(node, scope, templates, method.doc);
  const type = returnType(node, method.doc, scope, templates);
  if (type) method.type = type;
  const out = [method];
  for (const parameter of node.childForFieldName('parameters')?.namedChildren ?? []) {
    if (parameter.type !== 'property_promotion_parameter') continue;
    const variable = parameter.childForFieldName('name')!;
    const property = declare('property', variable.text.slice(1), parameter, variable, withoutAttributes(parameter));
    const param = method.params.find((p) => p.name === property.name);
    if (param?.type) property.type = param.type;
    if (param?.doc && !property.doc) property.doc = param.doc;
    out.push(property);
  }
  return out;
}

function propertySymbols(declaration: Node, scope: NameScope, templates: string[]): PhpSymbol[] {
  const elements = declaration.namedChildren.filter((c) => c.type === 'property_element');
  const declared = typeFromNode(declaration.childForFieldName('type'), scope);
  const vars = docVar(docComment(declaration));
  return elements.map((element) => {
    const variable = element.childForFieldName('name')!;
    const node = elements.length === 1 ? declaration : element;
    const symbol = declare('property', variable.text.slice(1), node, variable, propertySignature(declaration, element), declaration);
    const documented = vars.find((v) => !v.name || v.name === symbol.name)?.type;
    const type = pickType(declared, documented ? parseDocType(documented, scope, templates) : undefined);
    if (type) symbol.type = type;
    return symbol;
  });
}

/** Constantes d'un `const` : globales (avec nom complet) ou de classe. */
function constSymbols(declaration: Node, scope: NameScope, global: boolean): PhpSymbol[] {
  const elements = declaration.namedChildren.filter((c) => c.type === 'const_element');
  const declared = typeFromNode(declaration.childForFieldName('type'), scope);
  return elements.map((element) => {
    const nameNode = element.namedChildren.find((c) => c.type === 'name')!;
    const node = elements.length === 1 ? declaration : element;
    const symbol = declare(global ? 'constant' : 'classConstant', nameNode.text, node, nameNode, constSignature(declaration, element), declaration);
    if (global) symbol.fqn = qualify(scope, nameNode.text);
    if (declared) symbol.type = declared;
    return symbol;
  });
}

function functionSymbol(node: Node, scope: NameScope): PhpSymbol {
  const nameNode = node.childForFieldName('name')!;
  const symbol = declare('function', nameNode.text, node, nameNode, functionSignature(node));
  symbol.fqn = qualify(scope, nameNode.text);
  const templates = docTemplates(symbol.doc);
  if (templates.length) symbol.templates = templates;
  symbol.params = parametersOf(node, scope, templates, symbol.doc);
  const type = returnType(node, symbol.doc, scope, templates);
  if (type) symbol.type = type;
  return symbol;
}

/** « Type $name = défaut » d'un @method. */
function docParam(text: string, scope: NameScope, templates: string[]): PhpParam | undefined {
  const match = /^(?:(.*?)\s+)?(&)?(\.\.\.)?\$(\w+)(?:\s*=\s*(.*))?$/.exec(text.trim());
  if (!match) return undefined;
  const param: PhpParam = { name: match[4] };
  const type = match[1] ? parseDocType(match[1], scope, templates) : undefined;
  if (type) param.type = type;
  if (match[2]) param.byRef = true;
  if (match[3]) param.variadic = true;
  if (match[5] !== undefined) param.defaultValue = match[5].trim();
  return param;
}

/** Membres déclarés par @property et @method dans la doc de la classe. */
function virtualMembers(owner: PhpSymbol, scope: NameScope, templates: string[]): PhpSymbol[] {
  const at = owner.selectionRange;
  const out: PhpSymbol[] = [];
  for (const property of docProperties(owner.doc)) {
    const symbol: PhpSymbol = { kind: 'property', name: property.name, range: at, selectionRange: at, signature: squash(`@property ${property.type ?? ''} $${property.name}`), virtual: true };
    const type = property.type ? parseDocType(property.type, scope, templates) : undefined;
    if (type) symbol.type = type;
    if (property.description) symbol.doc = property.description;
    out.push(symbol);
  }
  for (const method of docMethods(owner.doc)) {
    const params = method.params.map((p) => docParam(p, scope, templates)).filter((p): p is PhpParam => !!p);
    const signature = squash(`${method.isStatic ? 'static ' : ''}function ${method.name}(${method.params.join(', ')})${method.returns ? `: ${method.returns}` : ''}`);
    const symbol: PhpSymbol = { kind: 'method', name: method.name, range: at, selectionRange: at, signature, virtual: true, params };
    if (method.isStatic) symbol.modifiers = ['public', 'static'];
    const type = method.returns ? parseDocType(method.returns, scope, templates) : undefined;
    if (type) symbol.type = type;
    if (method.description) symbol.doc = method.description;
    out.push(symbol);
  }
  return out;
}

function enumCaseSymbol(node: Node): PhpSymbol {
  const nameNode = node.childForFieldName('name')!;
  return declare('enumCase', nameNode.text, node, nameNode, squash(node.text.replace(/;\s*$/, '')));
}

/** Valeur d'une chaîne littérale sans interpolation, sinon undefined. */
function literalString(node: Node): string | undefined {
  if (node.type !== 'string' && node.type !== 'encapsed_string') return undefined;
  if (node.namedChildren.some((c) => c.type !== 'string_content' && c.type !== 'escape_sequence')) return undefined;
  return node.text.slice(1, -1);
}

/** `define('NOM', valeur)` : constante globale (le nom peut contenir un namespace). */
function defineSymbol(call: Node): PhpSymbol | undefined {
  const args = call.childForFieldName('arguments')?.namedChildren.filter((a) => a.type === 'argument') ?? [];
  const nameNode = args[0]?.namedChildren[0];
  const name = nameNode && literalString(nameNode);
  if (!nameNode || !name) return undefined;
  const fqn = name.replace(/^\\/, '');
  const statement = call.parent?.type === 'expression_statement' ? call.parent : call;
  const signature = squash(`define('${fqn}', ${truncate(args[1]?.text ?? '')})`);
  return { ...declare('constant', fqn.slice(fqn.lastIndexOf('\\') + 1), call, nameNode, signature, statement), fqn };
}
