// Arbre tree-sitter → résumé sérialisable d'un fichier : portées de noms, déclarations typées, inclusions.
// Une requête tree-sitter (exécutée en WASM) repère les nœuds utiles, traités dans l'ordre du fichier.
import { Query } from 'web-tree-sitter';
import type { FileSymbols, NameScope, PhpParam, PhpSymbol, SymbolKind, TypeExpr } from '../../shared/types.ts';
import { extractFlow } from '../includes/program.ts';
import { getLanguage, type Node, type Tree } from '../parser/parser.ts';
import { typeFromNode } from '../types/declType.ts';
import { parseDocType } from '../types/docType.ts';
import { Inferrer } from '../types/infer.ts';
import { levelTypeAware, parametersOf, pickType } from '../types/params.ts';
import { union } from '../types/type.ts';
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
(function_call_expression function: (name) @fn (#match? @fn "^[dD][eE][fF][iI][nN][eE]$")) @define
`;

const CLASS_KINDS: Record<string, SymbolKind> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  trait_declaration: 'trait',
  enum_declaration: 'enum',
};

const NAME_TYPES = new Set(['name', 'qualified_name', 'relative_name']);
const MEMBER_LISTS = new Set(['declaration_list', 'enum_declaration_list']);

const TOP_LEVEL = new Set(['program']);
const ARGUMENT_READERS = new Set(['func_get_args', 'func_num_args', 'func_get_arg']);

/** Déclaration dans un bloc (if, corps de fonction) plutôt qu'au niveau du fichier ou d'un namespace. */
function isConditional(node: Node): boolean {
  const parent = node.parent;
  if (!parent || TOP_LEVEL.has(parent.type)) return false;
  return !(parent.type === 'compound_statement' && parent.parent?.type === 'namespace_definition');
}

function readsArguments(fn: Node): boolean {
  const body = fn.childForFieldName('body');
  return !!body && body.descendantsOfType('function_call_expression').some((call) => ARGUMENT_READERS.has(call.childForFieldName('function')?.text.toLowerCase() ?? ''));
}

/** Déclaration dont le type sera déduit du code une fois le fichier entièrement lu. */
interface Pending {
  symbol: PhpSymbol;
  /** Fonction ou méthode, élément de propriété, élément de constante, ou argument valeur d'un define */
  node: Node;
  /** Pour une propriété : la classe (affectations $this->x) */
  owner?: Node;
}

/** Au-delà, un type déduit n'est pas conservé (taille du cache) */
const MAX_INFERRED = 2000;

let query: Query | undefined;

/**
 * `infer: false` : sans les types déduits du code ; `flow: false` : sans les programmes des variables ni les
 * includes (plus rapide, pour la frappe dans un document ouvert).
 */
export function extractFile(tree: Tree, uri: string, options: { infer?: boolean; flow?: boolean } = {}): FileSymbols {
  const root = tree.rootNode;
  const fileEnd = rangeOf(root).end;
  const fileScope = newScope('', rangeOf(root));
  const out: FileSymbols = { uri, symbols: [], includes: [], scopes: [fileScope], syntaxError: root.hasError };
  const pending: Pending[] = [];
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
        out.symbols.push(classSymbol(node, scope, pending));
        break;
      case 'function':
        out.symbols.push(functionSymbol(node, scope, pending));
        break;
      case 'const':
        if (!MEMBER_LISTS.has(node.parent?.type ?? '')) out.symbols.push(...constSymbols(node, scope, true, pending));
        break;
      case 'define': {
        const symbol = defineSymbol(node, pending);
        if (symbol) out.symbols.push(symbol);
        break;
      }
    }
  }
  const inferrer = options.infer !== false ? new Inferrer(out.scopes) : undefined;
  if (options.flow !== false) {
    const { flow, includes } = extractFlow(root, out.scopes, inferrer);
    out.flow = flow;
    out.includes = includes;
    // Noms du code, et noms écrits dans une chaîne qui a la forme d'un callable ('f', 'Classe::methode')
    const names = new Set(root.descendantsOfType('name').map((n) => n.text.toLowerCase()));
    for (const content of root.descendantsOfType('string_content')) {
      if (CALLABLE_STRING.test(content.text)) for (const part of content.text.toLowerCase().split(/::|\\/)) if (part) names.add(part);
    }
    out.names = [...names].sort();
  }
  if (inferrer) inferPending(out, pending, inferrer);
  return out;
}

const CALLABLE_STRING = /^\\?[A-Za-z_][\w\\]*(::[A-Za-z_]\w*)?$/;
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
  const deprecatedSince = /\bDeprecated\s*\([^\]]*?\bsince:\s*['"]([\d.]+)/.exec(attributes)?.[1] ?? versionOf(docTag(doc, 'deprecated'));
  if (symbol.deprecated && deprecatedSince) symbol.deprecatedSince = deprecatedSince;
  const deprecation = attributes.indexOf('Deprecated(');
  const replacement = deprecation >= 0 ? /replacement:\s*(['"])((?:\\.|(?!\1).)*)\1/.exec(attributes.slice(deprecation))?.[2] : undefined;
  if (replacement) symbol.replacement = replacement.replace(/\\(['"\\])/g, '$1');
  const available = /PhpStormStubsElementAvailable\s*\(([^)]*)\)/.exec(attributes)?.[1];
  const from = available ? (/from:\s*['"]([\d.]+)/.exec(available)?.[1] ?? /^\s*['"]([\d.]+)/.exec(available)?.[1]) : undefined;
  const to = available ? /to:\s*['"]([\d.]+)/.exec(available)?.[1] : undefined;
  const since = from ?? versionOf(docTag(doc, 'since'));
  const removed = versionOf(docTag(doc, 'removed'));
  if (since) symbol.since = since;
  if (to) symbol.until = to;
  if (removed) symbol.removed = removed;
}

function classSymbol(node: Node, scope: NameScope, pending: Pending[]): PhpSymbol {
  const kind = CLASS_KINDS[node.type];
  const nameNode = node.childForFieldName('name')!;
  const symbol = declare(kind, nameNode.text, node, nameNode, classSignature(node, kind));
  symbol.fqn = qualify(scope, nameNode.text);
  if (isConditional(node)) symbol.conditional = true;
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
    if (member.type === 'method_declaration') children.push(...methodSymbols(member, scope, templates, pending));
    else if (member.type === 'property_declaration') children.push(...propertySymbols(member, scope, templates, node, pending));
    else if (member.type === 'const_declaration') children.push(...constSymbols(member, scope, false, pending));
    else if (member.type === 'use_declaration') traits.push(...classNames(member, scope));
    else if (member.type === 'enum_case') children.push(enumCaseSymbol(member));
  }
  children.push(...virtualMembers(symbol, scope, templates));
  children.push(...dynamicProperties(node, children, pending, symbol));
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

function methodSymbols(node: Node, scope: NameScope, classTemplates: string[], pending: Pending[]): PhpSymbol[] {
  const nameNode = node.childForFieldName('name')!;
  const method = declare('method', nameNode.text, node, nameNode, functionSignature(node));
  const own = docTemplates(method.doc);
  if (own.length) method.templates = own;
  const templates = [...classTemplates, ...own];
  method.params = parametersOf(node, scope, templates, method.doc);
  if (readsArguments(node)) method.variadicBody = true;
  const type = returnType(node, method.doc, scope, templates);
  if (type) method.type = type;
  else pending.push({ symbol: method, node });
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

function propertySymbols(declaration: Node, scope: NameScope, templates: string[], owner: Node, pending: Pending[]): PhpSymbol[] {
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
    else pending.push({ symbol, node: element, owner });
    return symbol;
  });
}

/** Constantes d'un `const` : globales (avec nom complet) ou de classe. */
function constSymbols(declaration: Node, scope: NameScope, global: boolean, pending: Pending[]): PhpSymbol[] {
  const elements = declaration.namedChildren.filter((c) => c.type === 'const_element');
  const declared = typeFromNode(declaration.childForFieldName('type'), scope);
  return elements.map((element) => {
    const nameNode = element.namedChildren.find((c) => c.type === 'name')!;
    const node = elements.length === 1 ? declaration : element;
    const symbol = declare(global ? 'constant' : 'classConstant', nameNode.text, node, nameNode, constSignature(declaration, element), declaration);
    if (global) symbol.fqn = qualify(scope, nameNode.text);
    if (declared) symbol.type = declared;
    else pending.push({ symbol, node: element });
    return symbol;
  });
}

function functionSymbol(node: Node, scope: NameScope, pending: Pending[]): PhpSymbol {
  const nameNode = node.childForFieldName('name')!;
  const symbol = declare('function', nameNode.text, node, nameNode, functionSignature(node));
  symbol.fqn = qualify(scope, nameNode.text);
  if (isConditional(node)) symbol.conditional = true;
  if (readsArguments(node)) symbol.variadicBody = true;
  const templates = docTemplates(symbol.doc);
  if (templates.length) symbol.templates = templates;
  symbol.params = parametersOf(node, scope, templates, symbol.doc);
  const type = returnType(node, symbol.doc, scope, templates);
  if (type) symbol.type = type;
  else pending.push({ symbol, node });
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
function defineSymbol(call: Node, pending: Pending[]): PhpSymbol | undefined {
  const args = call.childForFieldName('arguments')?.namedChildren.filter((a) => a.type === 'argument') ?? [];
  const nameNode = args[0]?.namedChildren[0];
  const name = nameNode && literalString(nameNode);
  if (!nameNode || !name) return undefined;
  const fqn = name.replace(/^\\/, '');
  const statement = call.parent?.type === 'expression_statement' ? call.parent : call;
  const signature = squash(`define('${fqn}', ${truncate(args[1]?.text ?? '')})`);
  const symbol: PhpSymbol = { ...declare('constant', fqn.slice(fqn.lastIndexOf('\\') + 1), call, nameNode, signature, statement), fqn };
  if (args[1]) pending.push({ symbol, node: args[1] });
  return symbol;
}

/** Types déduits du code pour les déclarations sans type : retours, valeurs, affectations $this->x. */
function inferPending(file: FileSymbols, pending: Pending[], inferrer: Inferrer): void {
  if (!pending.length) return;
  const assignments = new Map<number, Map<string, Node[]>>();
  for (const { symbol, node, owner } of pending) {
    let type: TypeExpr | undefined;
    if (symbol.kind === 'function' || symbol.kind === 'method') {
      type = inferrer.inferReturn(node);
    } else if (symbol.kind === 'property') {
      const values: TypeExpr[] = [];
      const initial = node.childForFieldName('default_value');
      if (initial) values.push(inferrer.expr(initial));
      if (owner) {
        let byName = assignments.get(owner.id);
        if (!byName) assignments.set(owner.id, (byName = thisAssignments(owner)));
        for (const right of byName.get(symbol.name) ?? []) values.push(inferrer.expr(right));
      }
      if (values.length) type = union(...values);
    } else {
      // Constante : `NOM = valeur` (le nom est le premier enfant) ou argument valeur d'un define
      const children = node.namedChildren;
      const value = children[children.length - 1];
      if (value && (node.type !== 'const_element' || children.length > 1)) type = inferrer.expr(value);
    }
    if (type && type.kind !== 'mixed' && JSON.stringify(type).length <= MAX_INFERRED) symbol.inferred = type;
  }
}

/**
 * Propriétés écrites par `$this->x = …`, `$this->x[] = …`, `$this->x += …`, `$this->x++` dans les méthodes sans
 * être déclarées (code historique). `$this->$nom = …` : la classe crée des propriétés quelconques (`dynamic`).
 */
function dynamicProperties(classNode: Node, children: PhpSymbol[], pending: Pending[], owner: PhpSymbol): PhpSymbol[] {
  const declared = new Set(children.filter((c) => c.kind === 'property').map((c) => c.name));
  const { names, dynamic } = thisWrites(classNode);
  if (dynamic) owner.dynamic = true;
  const out: PhpSymbol[] = [];
  for (const [name, node] of names) {
    if (declared.has(name)) continue;
    const at = rangeOf(node);
    const symbol: PhpSymbol = { kind: 'property', name, range: at, selectionRange: at, signature: `public $${name}`, modifiers: ['public'], dynamic: true };
    pending.push({ symbol, node: classNode, owner: classNode });
    out.push(symbol);
  }
  return out;
}

/** Cible écrite : le membre sous les indices (`$this->x['k'][] = …` → `$this->x`). */
export function writtenMember(target: Node | null | undefined): Node | undefined {
  let node = target;
  while (node && node.type === 'subscript_expression') node = node.namedChildren[0];
  return node && (node.type === 'member_access_expression' || node.type === 'nullsafe_member_access_expression') ? node : undefined;
}

/** Cible d'une écriture : gauche d'une affectation, opérande de ++ / --. */
export function writeTarget(node: Node): Node | undefined {
  if (node.type === 'assignment_expression' || node.type === 'augmented_assignment_expression' || node.type === 'reference_assignment_expression') return node.childForFieldName('left') ?? undefined;
  if (node.type === 'update_expression') return node.namedChildren[0];
  return undefined;
}

function thisWrites(owner: Node): { names: Map<string, Node>; dynamic: boolean } {
  const names = new Map<string, Node>();
  let dynamic = false;
  const visit = (node: Node): void => {
    for (const child of node.namedChildren) {
      if (child.type === 'class_declaration' || child.type === 'anonymous_class') continue;
      const member = writtenMember(writeTarget(child));
      if (member && member.childForFieldName('object')?.text === '$this') {
        const name = member.childForFieldName('name');
        if (name?.type === 'name') {
          if (!names.has(name.text)) names.set(name.text, child);
        } else if (name) dynamic = true;
      }
      visit(child);
    }
  };
  visit(owner.childForFieldName('body') ?? owner);
  return { names, dynamic };
}

/** Affectations `$this->nom = valeur` dans les méthodes d'une classe, par nom de propriété. */
function thisAssignments(owner: Node): Map<string, Node[]> {
  const out = new Map<string, Node[]>();
  const visit = (node: Node): void => {
    for (const child of node.namedChildren) {
      if (child.type === 'class_declaration' || child.type === 'anonymous_class') continue;
      if (child.type === 'assignment_expression') {
        const left = child.childForFieldName('left');
        const object = left?.childForFieldName('object');
        const name = left?.childForFieldName('name');
        const right = child.childForFieldName('right');
        if (left?.type === 'member_access_expression' && object?.text === '$this' && name?.type === 'name' && right) {
          const list = out.get(name.text);
          if (list) list.push(right);
          else out.set(name.text, [right]);
        }
      }
      visit(child);
    }
  };
  visit(owner.childForFieldName('body') ?? owner);
  return out;
}
