// Complétion : variables, membres selon le type (visibilité respectée), membres statiques, fonctions, classes et
// constantes (filtrées par version de PHP), mots-clés, chemins d'include, clés de tableaux connues, balises
// phpdoc. La documentation est chargée à la demande (completionItem/resolve).
import { readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { CompletionItemKind, CompletionItemTag, InsertTextFormat, type CompletionItem, type CompletionList, type TextEdit } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import type { NameScope, PhpSymbol, Position, Range, SymbolKind, TypeExpr } from '../../shared/types.ts';
import type { OpenDocument } from '../documents.ts';
import { hoverMarkdown } from '../features/hover.ts';
import { addUse, useConflict } from '../imports/uses.ts';
import { matchScore } from '../features/workspaceSymbols.ts';
import { enclosingClass, FUNCTION_NODES } from '../model/context.ts';
import { resolveClassName, resolveFunctionOrConstant, scopeAt } from '../model/names.ts';
import type { Node, Parser } from '../parser/parser.ts';
import { isAvailable } from '../stubs/availability.ts';
import { bindingAt, type MemberHit, type TypeResolver } from '../types/expand.ts';
import { externalFor } from '../types/external.ts';
import { scopeRoot } from '../types/flow.ts';
import { Inferrer } from '../types/infer.ts';
import { formatParam, formatType, members } from '../types/type.ts';
import { completionContext, PLACEHOLDER, type CompletionContext, type NameMode } from './context.ts';

export interface CompletionEnv {
  resolver: TypeResolver;
  parser: Parser;
  folders: string[];
}

/** Ce qu'il faut pour retrouver la déclaration d'un élément lors de `completionItem/resolve`. */
export interface ItemData {
  kind: 'function' | 'class' | 'constant' | 'member';
  fqn?: string;
  owner?: string;
  name?: string;
  memberKind?: SymbolKind;
}

const LIMIT = 300;
const KEYWORDS = [
  'abstract', 'array', 'as', 'break', 'case', 'catch', 'class', 'clone', 'const', 'continue', 'declare', 'default', 'do',
  'echo', 'else', 'elseif', 'empty', 'enum', 'extends', 'false', 'final', 'finally', 'fn', 'for', 'foreach', 'function',
  'global', 'if', 'implements', 'include', 'include_once', 'instanceof', 'insteadof', 'interface', 'isset', 'list',
  'match', 'namespace', 'new', 'null', 'print', 'private', 'protected', 'public', 'readonly', 'require', 'require_once',
  'return', 'static', 'switch', 'throw', 'trait', 'true', 'try', 'unset', 'use', 'while', 'yield',
];
const TYPE_KEYWORDS = ['array', 'bool', 'callable', 'false', 'float', 'int', 'iterable', 'mixed', 'never', 'null', 'object', 'parent', 'self', 'static', 'string', 'true', 'void'];
const DOC_TAGS = [
  '@param', '@return', '@var', '@throws', '@deprecated', '@see', '@link', '@since', '@property', '@property-read',
  '@property-write', '@method', '@mixin', '@template', '@extends', '@implements', '@inheritDoc', '@internal', '@api',
  '@todo', '@author', '@version',
];
const SUPERGLOBALS = ['GLOBALS', '_SERVER', '_GET', '_POST', '_FILES', '_COOKIE', '_SESSION', '_REQUEST', '_ENV'];
const KINDS: Record<SymbolKind, CompletionItemKind> = {
  class: CompletionItemKind.Class,
  interface: CompletionItemKind.Interface,
  trait: CompletionItemKind.Class,
  enum: CompletionItemKind.Enum,
  function: CompletionItemKind.Function,
  method: CompletionItemKind.Method,
  property: CompletionItemKind.Property,
  constant: CompletionItemKind.Constant,
  classConstant: CompletionItemKind.Constant,
  enumCase: CompletionItemKind.EnumMember,
};
const CLASS_LIKE = new Set<SymbolKind>(['class', 'interface', 'trait', 'enum']);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isStatic = (symbol: PhpSymbol) => symbol.modifiers?.includes('static') ?? false;

export function complete(env: CompletionEnv, doc: OpenDocument, position: Position): CompletionList {
  const offset = doc.doc.offsetAt(position);
  const { tree, context } = completionContext(env.parser, doc.doc.getText(), offset, { tree: doc.tree, position });
  try {
    return new Completion(env, doc, position, offset).run(context);
  } finally {
    tree.delete();
  }
}

export function resolveCompletion(resolver: TypeResolver, item: CompletionItem): CompletionItem {
  const symbol = findItemSymbol(resolver, item.data as ItemData | undefined);
  if (symbol) {
    if (symbol.signature) item.detail = symbol.signature;
    item.documentation = { kind: 'markdown', value: hoverMarkdown(symbol, 1) };
  }
  return item;
}

function findItemSymbol(resolver: TypeResolver, data: ItemData | undefined): PhpSymbol | undefined {
  if (!data) return undefined;
  const lookup = resolver.lookup;
  switch (data.kind) {
    case 'function':
      return data.fqn ? resolver.pick(lookup.findFunction(data.fqn))?.symbol : undefined;
    case 'constant':
      return data.fqn ? resolver.pick(lookup.findConstant(data.fqn))?.symbol : undefined;
    case 'class':
      return data.fqn ? lookup.findClass(data.fqn)[0]?.symbol : undefined;
    case 'member':
      return data.owner && data.name && data.memberKind ? resolver.findMember({ fqn: data.owner }, data.name, [data.memberKind])[0]?.member : undefined;
  }
}

/** `name(…)` en snippet, avec l'aide aux paramètres déclenchée s'il y en a. */
function callSnippet(item: CompletionItem, text: string, hasParams: boolean, range?: Range): void {
  const newText = hasParams ? `${text}($0)` : `${text}()`;
  if (range) item.textEdit = { range, newText };
  else item.insertText = newText;
  item.insertTextFormat = InsertTextFormat.Snippet;
  if (hasParams) item.command = { title: 'Parameter hints', command: 'editor.action.triggerParameterHints' };
}

function inStaticMethod(node: Node): boolean {
  for (let n = node.parent; n; n = n.parent) {
    if (n.type === 'method_declaration') return n.namedChildren.some((c) => c.type === 'static_modifier');
  }
  return false;
}

/** Noms de variables d'une portée (paramètres compris), sans entrer dans les fonctions imbriquées. */
function collectVariables(root: Node, names: Set<string>): void {
  const visit = (node: Node): void => {
    for (const child of node.namedChildren) {
      if (child.type === 'variable_name' && node.type !== 'scoped_property_access_expression' && node.type !== 'property_element') names.add(child.text.slice(1));
      if (FUNCTION_NODES.has(child.type) || child.type === 'class_declaration' || child.type === 'anonymous_class') continue;
      visit(child);
    }
  };
  visit(root);
}

class Completion {
  readonly #env: CompletionEnv;
  readonly #doc: OpenDocument;
  readonly #position: Position;
  readonly #offset: number;
  readonly #inferrer: Inferrer;
  readonly #items: CompletionItem[] = [];
  #incomplete = false;

  constructor(env: CompletionEnv, doc: OpenDocument, position: Position, offset: number) {
    this.#env = env;
    this.#doc = doc;
    this.#position = position;
    this.#offset = offset;
    this.#inferrer = new Inferrer(doc.symbols.scopes);
  }

  run(context: CompletionContext): CompletionList {
    switch (context.kind) {
      case 'variable':
        this.#variables(context.prefix, context.node);
        break;
      case 'member':
        this.#members(context.object, context.node);
        break;
      case 'static':
        this.#statics(context.scope, context.node, context.variable);
        break;
      case 'name':
        this.#names(context.prefix, context.mode);
        break;
      case 'include':
        this.#includes(context.prefix);
        break;
      case 'arrayKey':
        this.#arrayKeys(context.prefix, context.target);
        break;
      case 'docTag':
        this.#docTags(context.prefix);
        break;
    }
    return { isIncomplete: this.#incomplete, items: this.#items };
  }

  /** Plage qui remplace les `length` caractères tapés avant le curseur. */
  #replace(length: number): Range {
    return { start: this.#doc.doc.positionAt(this.#offset - length), end: this.#position };
  }

  #type(node: Node): TypeExpr {
    return this.#env.resolver.expand(this.#inferrer.expr(node), bindingAt(node, this.#doc.symbols.scopes));
  }

  #variables(prefix: string, at: Node): void {
    const root = scopeRoot(at);
    const names = new Set<string>();
    collectVariables(root, names);
    if (root.type === 'arrow_function') collectVariables(scopeRoot(root), names);
    if (root.type === 'program') for (const name of externalFor(this.#doc.symbols.scopes)?.names(this.#position) ?? []) names.add(name);
    for (const name of names) if (name.includes(PLACEHOLDER)) names.delete(name);
    if (enclosingClass(at, this.#doc.symbols.scopes) && root.type !== 'program' && !inStaticMethod(at)) names.add('this');
    for (const name of SUPERGLOBALS) names.add(name);
    const range = this.#replace(prefix.length + 1);
    let typed = 0;
    for (const name of [...names].sort()) {
      const item: CompletionItem = { label: `$${name}`, kind: CompletionItemKind.Variable, textEdit: { range, newText: `$${name}` } };
      if (!SUPERGLOBALS.includes(name) && typed++ < 50) {
        const type = formatType(this.#env.resolver.expand(this.#inferrer.variable(name, at), bindingAt(at, this.#doc.symbols.scopes)));
        if (type !== 'mixed') item.labelDetails = { description: type };
      }
      this.#items.push(item);
    }
  }

  #members(object: Node, at: Node): void {
    const enclosing = enclosingClass(at, this.#doc.symbols.scopes);
    const seen = new Set<string>();
    for (const receiver of members(this.#type(object))) {
      if (receiver.kind !== 'class') continue;
      for (const hit of this.#env.resolver.membersOf(receiver, ['method', 'property'])) {
        if (!isStatic(hit.member) && this.#visible(hit, enclosing)) this.#pushMember(hit, false, seen);
      }
    }
  }

  #statics(scope: Node, at: Node, variable: boolean): void {
    const enclosing = enclosingClass(at, this.#doc.symbols.scopes);
    const relative = ['self', 'static', 'parent'].includes(scope.text.trim().toLowerCase());
    const instance = relative && !!enclosing && !inStaticMethod(at);
    const owner = this.#env.resolver.expand(this.#inferrer.classOf(scope), bindingAt(at, this.#doc.symbols.scopes));
    const seen = new Set<string>();
    for (const receiver of members(owner)) {
      if (receiver.kind !== 'class') continue;
      for (const hit of this.#env.resolver.membersOf(receiver, ['method', 'property', 'classConstant', 'enumCase'])) {
        const member = hit.member;
        const wanted = variable
          ? member.kind === 'property' && isStatic(member)
          : member.kind === 'classConstant' || member.kind === 'enumCase' || isStatic(member) || (instance && member.kind === 'method');
        if (wanted && this.#visible(hit, enclosing)) this.#pushMember(hit, true, seen);
      }
    }
    if (!variable) this.#items.push({ label: 'class', kind: CompletionItemKind.Keyword });
  }

  #pushMember(hit: MemberHit, staticAccess: boolean, seen: Set<string>): void {
    const member = hit.member;
    const label = member.kind === 'property' && staticAccess ? `$${member.name}` : member.name;
    if (seen.has(label)) return;
    seen.add(label);
    const data: ItemData = { kind: 'member', owner: hit.owner.symbol.fqn, name: member.name, memberKind: member.kind };
    const item: CompletionItem = { label, kind: KINDS[member.kind], data };
    if (member.deprecated) item.tags = [CompletionItemTag.Deprecated];
    const type = formatType(this.#env.resolver.expand(this.#env.resolver.returnOf(member), hit.binding));
    if (member.kind === 'method') {
      const params = member.params ?? [];
      item.labelDetails = { detail: `(${params.map((p) => formatParam(p)).join(', ')})`, description: type };
      callSnippet(item, member.name, params.length > 0);
    } else if (type !== 'mixed') {
      item.labelDetails = { description: type };
    }
    this.#items.push(item);
  }

  #visible(hit: MemberHit, enclosing: string | undefined): boolean {
    const modifiers = hit.member.modifiers ?? [];
    const owner = hit.owner.symbol.fqn ?? '';
    if (modifiers.includes('private')) return !!enclosing && same(enclosing, owner);
    if (modifiers.includes('protected')) return !!enclosing && (this.#inherits(enclosing, owner) || this.#inherits(owner, enclosing));
    return true;
  }

  #inherits(child: string, ancestor: string): boolean {
    for (const { hit } of this.#env.resolver.hierarchy(child)) if (hit.symbol.fqn && same(hit.symbol.fqn, ancestor)) return true;
    return false;
  }

  #names(prefix: string, mode: NameMode): void {
    const scope = scopeAt(this.#doc.symbols.scopes, this.#position);
    const qualified = prefix.includes('\\');
    const query = (qualified ? prefix.replace(/^\\/, '') : prefix).toLowerCase();
    const range = this.#replace(prefix.length);
    const lookup = this.#env.resolver.lookup;
    const hits: { score: number; symbol: PhpSymbol }[] = [];
    const seen = new Set<string>();
    const consider = (symbol: PhpSymbol, stub: boolean) => {
      if (!symbol.fqn) return;
      const isClass = CLASS_LIKE.has(symbol.kind);
      if (mode === 'any' ? !(isClass || symbol.kind === 'function' || symbol.kind === 'constant') : !isClass) return;
      if (mode === 'new' && (symbol.kind !== 'class' || symbol.modifiers?.includes('abstract'))) return;
      if (stub && !isAvailable(symbol, this.#env.resolver.phpVersion)) return;
      const score = query ? matchScore((qualified ? symbol.fqn : symbol.name).toLowerCase(), query) : 1;
      if (!score) return;
      const key = `${isClass ? 'class' : symbol.kind}:${symbol.fqn.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      hits.push({ score, symbol });
    };
    for (const file of lookup.workspace.files()) for (const symbol of file.symbols) consider(symbol, false);
    for (const file of lookup.stubs.files()) for (const symbol of file.symbols) consider(symbol, true);
    hits.sort((a, b) => b.score - a.score || (a.symbol.name < b.symbol.name ? -1 : a.symbol.name > b.symbol.name ? 1 : 0));
    if (hits.length > LIMIT) this.#incomplete = true;
    for (const { symbol } of hits.slice(0, LIMIT)) this.#items.push(this.#globalItem(symbol, scope, prefix, mode, range));
    if (qualified) return;
    const keywords = mode === 'type' ? TYPE_KEYWORDS : mode === 'any' ? KEYWORDS : [];
    for (const keyword of keywords) {
      if (keyword.startsWith(query)) this.#items.push({ label: keyword, kind: CompletionItemKind.Keyword, textEdit: { range, newText: keyword } });
    }
  }

  #globalItem(symbol: PhpSymbol, scope: NameScope, prefix: string, mode: NameMode, range: Range): CompletionItem {
    const fqn = symbol.fqn!;
    const kind: ItemData['kind'] = CLASS_LIKE.has(symbol.kind) ? 'class' : symbol.kind === 'function' ? 'function' : 'constant';
    let text: string;
    let imported: TextEdit | undefined;
    if (mode === 'use') text = fqn;
    else if (prefix.includes('\\')) text = `\\${fqn}`;
    else {
      const reachable = kind === 'class'
        ? same(resolveClassName(symbol.name, scope) ?? '', fqn)
        : resolveFunctionOrConstant(symbol.name, kind, scope).some((c) => same(c, fqn));
      text = symbol.name;
      if (!reachable) {
        // Import automatique : `use` ajouté à sa place, sauf conflit de nom court (nom complet alors)
        const useKind = kind === 'class' ? 'class' : kind === 'function' ? 'function' : 'const';
        const tree = this.#doc.tree;
        if (fqn.includes('\\') && !useConflict(tree, fqn, useKind)) imported = addUse(tree, this.#text(), fqn, useKind);
        if (!imported) text = `\\${fqn}`;
      }
    }
    const data: ItemData = { kind, fqn };
    const item: CompletionItem = {
      label: symbol.name,
      kind: KINDS[symbol.kind],
      data,
      textEdit: { range, newText: text },
      filterText: prefix.includes('\\') ? (prefix.startsWith('\\') ? `\\${fqn}` : fqn) : symbol.name,
    };
    const namespace = fqn.includes('\\') ? fqn.slice(0, fqn.lastIndexOf('\\')) : '';
    if (namespace) item.labelDetails = { description: namespace };
    if (symbol.deprecated) item.tags = [CompletionItemTag.Deprecated];
    if (kind === 'function') callSnippet(item, text, (symbol.params?.length ?? 0) > 0, range);
    if (imported) item.additionalTextEdits = [imported];
    return item;
  }

  #fullText: string | undefined;

  /** Texte du document, lu une fois par complétion. */
  #text(): string {
    return (this.#fullText ??= this.#doc.doc.getText());
  }

  #includes(prefix: string): void {
    const dirPart = prefix.slice(0, prefix.lastIndexOf('/') + 1);
    const partial = prefix.slice(dirPart.length);
    const file = URI.parse(this.#doc.uri).fsPath;
    const base = prefix.startsWith('/') ? (this.#env.folders.find((f) => file.startsWith(f + path.sep)) ?? path.dirname(file)) : path.dirname(file);
    let entries: Dirent[];
    try {
      entries = readdirSync(path.join(base, dirPart), { withFileTypes: true });
    } catch {
      return;
    }
    const range = this.#replace(partial.length);
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.isDirectory()) {
        this.#items.push({ label: `${entry.name}/`, kind: CompletionItemKind.Folder, textEdit: { range, newText: `${entry.name}/` }, command: { title: 'Suggest', command: 'editor.action.triggerSuggest' } });
      } else if (/\.(php\d?|inc|phtml|html?)$/i.test(entry.name)) {
        this.#items.push({ label: entry.name, kind: CompletionItemKind.File, textEdit: { range, newText: entry.name } });
      }
    }
  }

  #arrayKeys(prefix: string, target: Node): void {
    const range = this.#replace(prefix.length);
    for (const type of members(this.#type(target))) {
      if (type.kind !== 'array' || !type.shape) continue;
      for (const [key, value] of Object.entries(type.shape)) {
        this.#items.push({ label: key, kind: CompletionItemKind.Field, labelDetails: { description: formatType(value) }, textEdit: { range, newText: key } });
      }
    }
  }

  #docTags(prefix: string): void {
    const range = this.#replace(prefix.length + 1);
    for (const tag of DOC_TAGS) {
      if (tag.slice(1).startsWith(prefix)) this.#items.push({ label: tag, kind: CompletionItemKind.Keyword, textEdit: { range, newText: tag } });
    }
  }
}
