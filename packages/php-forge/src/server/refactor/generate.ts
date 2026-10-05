// Génération de code au curseur : getters / setters, constructeur (promotion de propriétés à partir de PHP 8),
// méthodes abstraites à implémenter, squelette phpdoc, @var d'une variable. Style PSR-12 : 4 espaces,
// accolade de méthode à la ligne, indentation reprise de la classe.
import * as l10n from '@vscode/l10n';
import { CodeActionKind, type CodeAction, type Range, type TextEdit } from 'vscode-languageserver/node';
import type { FileSymbols, PhpParam, PhpSymbol, TypeExpr } from '../../shared/types.ts';
import type { Lookup } from '../index/lookup.ts';
import { docComment } from '../model/phpdoc.ts';
import { rangeOf } from '../model/ranges.ts';
import type { Node, Tree } from '../parser/parser.ts';
import { compareVersions } from '../stubs/availability.ts';
import { bindingAt, type TypeResolver } from '../types/expand.ts';
import { Inferrer } from '../types/infer.ts';

export interface GenerateInput {
  uri: string;
  text: string;
  tree: Tree;
  symbols: FileSymbols;
}

export interface GenerateEnv {
  lookup: Lookup;
  resolver: TypeResolver;
  phpVersion?: string;
}

const KEYWORDS = new Set(['int', 'float', 'string', 'bool', 'array', 'callable', 'iterable', 'object', 'mixed', 'void', 'never', 'null', 'false', 'true', 'self', 'static', 'parent']);
const ucfirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const atLeast = (version: string | undefined, min: string) => !version || compareVersions(version, min) >= 0;

/** Noms complets des classes d'un type, par nom court en minuscules. */
function classNames(type: TypeExpr | undefined, out = new Map<string, string>()): Map<string, string> {
  if (!type) return out;
  if (type.kind === 'class') out.set(type.fqn.slice(type.fqn.lastIndexOf('\\') + 1).toLowerCase(), type.fqn);
  if (type.kind === 'union' || type.kind === 'intersection') for (const t of type.types) classNames(t, out);
  return out;
}

/** Type écrit dans une signature, réécrit pour un autre fichier : mots-clés inchangés, classes en nom complet. */
export function declaredType(written: string, type: TypeExpr | undefined): string {
  const names = classNames(type);
  return written.replace(/\\?[A-Za-z_][\w\\]*/g, (name) => {
    if (KEYWORDS.has(name.toLowerCase())) return name;
    if (name.startsWith('\\')) return name;
    const short = name.slice(name.lastIndexOf('\\') + 1).toLowerCase();
    return `\\${names.get(short) ?? name}`;
  });
}

/** Ligne d'un nœud et son indentation. */
function indentOf(text: string, line: number): string {
  return /^\s*/.exec(text.split('\n')[line] ?? '')![0];
}

const at = (line: number, character = 0) => ({ line, character });
const insert = (line: number, newText: string): TextEdit => ({ range: { start: at(line), end: at(line) }, newText });

function action(title: string, input: GenerateInput, edits: TextEdit[], kind: string = CodeActionKind.Refactor): CodeAction {
  return { title, kind, edit: { changes: { [input.uri]: edits } } };
}

/** Nœud nommé le plus profond qui contient la position. */
function nodeAt(tree: Tree, range: Range): Node {
  return tree.rootNode.namedDescendantForPosition({ row: range.start.line, column: range.start.character }) ?? tree.rootNode;
}

function ancestor(node: Node | null, types: string[]): Node | undefined {
  for (let n: Node | null = node; n; n = n.parent) if (types.includes(n.type)) return n;
  return undefined;
}

/** Méthode PSR-12 indentée de `indent` (un niveau de plus pour le corps). */
function method(indent: string, header: string, body: string[]): string {
  return `${indent}${header}\n${indent}{\n${body.map((l) => `${indent}    ${l}`).join('\n')}${body.length ? '\n' : ''}${indent}}\n`;
}

interface PropertyInfo {
  name: string;
  written?: string;
  node: Node;
  hasDefault: boolean;
  alone: boolean;
  documented: boolean;
  isStatic: boolean;
}

function properties(body: Node): PropertyInfo[] {
  const out: PropertyInfo[] = [];
  for (const decl of body.namedChildren) {
    if (decl.type !== 'property_declaration') continue;
    const elements = decl.namedChildren.filter((c) => c.type === 'property_element');
    const isStatic = decl.namedChildren.some((c) => c.type === 'static_modifier');
    const written = decl.childForFieldName('type')?.text;
    for (const element of elements) {
      const name = element.namedChildren.find((c) => c.type === 'variable_name')?.text.replace(/^\$/, '');
      if (!name) continue;
      out.push({ name, ...(written ? { written } : {}), node: decl, hasDefault: element.childForFieldName('default_value') !== null || /=/.test(element.text), alone: elements.length === 1, documented: !!docComment(decl), isStatic });
    }
  }
  return out;
}

function visibility(decl: Node): string {
  return decl.namedChildren.find((c) => c.type === 'visibility_modifier')?.text ?? 'public';
}

function accessors(input: GenerateInput, env: GenerateEnv, body: Node, only?: string): CodeAction[] {
  const methods = new Set(body.namedChildren.filter((c) => c.type === 'method_declaration').map((m) => m.childForFieldName('name')?.text.toLowerCase() ?? ''));
  const indent = indentOf(input.text, rangeOf(body).start.line) + '    ';
  const parts: string[] = [];
  for (const p of properties(body)) {
    if (p.isStatic || (only && p.name !== only)) continue;
    const type = p.written ? `: ${p.written}` : '';
    const isBool = /^\??bool$/i.test(p.written ?? '');
    if (!methods.has(`get${p.name}`.toLowerCase()) && !(isBool && methods.has(`is${p.name}`.toLowerCase()))) {
      parts.push(method(indent, `public function get${ucfirst(p.name)}()${type}`, [`return $this->${p.name};`]));
    }
    if (!methods.has(`set${p.name}`.toLowerCase())) {
      const param = `${p.written ? `${p.written} ` : ''}$${p.name}`;
      parts.push(method(indent, `public function set${ucfirst(p.name)}(${param})${atLeast(env.phpVersion, '7.1') ? ': void' : ''}`, [`$this->${p.name} = $${p.name};`]));
    }
  }
  if (!parts.length) return [];
  const close = rangeOf(body).end.line;
  const title = only ? l10n.t('Generate getter and setter for {0}', `$${only}`) : l10n.t('Generate getters and setters');
  return [action(title, input, [insert(close, parts.map((p) => `\n${p}`).join(''))])];
}

function constructor(input: GenerateInput, env: GenerateEnv, body: Node): CodeAction[] {
  const members = body.namedChildren;
  if (members.some((c) => c.type === 'method_declaration' && c.childForFieldName('name')?.text.toLowerCase() === '__construct')) return [];
  const props = properties(body).filter((p) => !p.isStatic && !p.hasDefault);
  if (!props.length) return [];
  const indent = indentOf(input.text, rangeOf(body).start.line) + '    ';
  const lines = input.text.split('\n');
  const title = l10n.t('Generate constructor');
  if (atLeast(env.phpVersion, '8.0')) {
    const promoted = props.filter((p) => p.alone && !p.documented);
    if (promoted.length) {
      const params = promoted.map((p) => `${indent}    ${visibility(p.node)} ${p.written ? `${p.written} ` : ''}$${p.name},`).join('\n');
      const text = `${indent}public function __construct(\n${params}\n${indent}) {\n${indent}}\n`;
      const edits: TextEdit[] = promoted.map((p, i) => {
        const line = rangeOf(p.node).start.line;
        return { range: { start: at(line), end: at(line + 1) }, newText: i === 0 ? text : '' };
      });
      return [action(title, input, edits)];
    }
  }
  const last = Math.max(...properties(body).map((p) => rangeOf(p.node).end.line));
  const params = props.map((p) => `${p.written ? `${p.written} ` : ''}$${p.name}`).join(', ');
  const blankAfter = (lines[last + 1] ?? '').trim() === '' ? '' : '\n';
  const text = `\n${method(indent, `public function __construct(${params})`, props.map((p) => `$this->${p.name} = $${p.name};`))}${blankAfter}`;
  return [action(title, input, [insert(last + 1, text)])];
}

/** Signature déclarée (`function f(int $x): T`) → en-tête réécrit pour la classe qui implémente. */
function implementation(symbol: PhpSymbol, indent: string): string {
  const signature = symbol.signature ?? '';
  const open = signature.indexOf('(');
  const close = signature.lastIndexOf(')');
  const writtenParams = open >= 0 && close > open ? splitParams(signature.slice(open + 1, close)) : [];
  const params = (symbol.params ?? []).map((p: PhpParam, i) => {
    const written = writtenParams[i] ?? '';
    const typeText = /^(.*?)\s*&?\s*(\.\.\.)?\$/.exec(written)?.[1]?.trim();
    const type = typeText ? `${declaredType(typeText, p.type)} ` : '';
    const value = p.defaultValue !== undefined ? ` = ${p.defaultValue}` : '';
    return `${type}${p.byRef ? '&' : ''}${p.variadic ? '...' : ''}$${p.name}${value}`;
  });
  const returns = /\)\s*:\s*([^{;]+)$/.exec(signature.slice(close))?.[1]?.trim();
  const modifiers = (symbol.modifiers ?? []).filter((m) => m !== 'abstract');
  const visibilityText = modifiers.find((m) => ['public', 'protected', 'private'].includes(m)) ?? 'public';
  const isStatic = modifiers.includes('static') ? ' static' : '';
  const header = `${visibilityText}${isStatic} function ${symbol.name}(${params.join(', ')})${returns ? `: ${declaredType(returns, symbol.type)}` : ''}`;
  return method(indent, header, ["throw new \\BadMethodCallException('Not implemented');"]);
}

/** Paramètres d'une liste écrite, sans couper dans les parenthèses ni les chaînes. */
function splitParams(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const ch of list) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function missingMethods(input: GenerateInput, env: GenerateEnv, classNode: Node, body: Node): CodeAction[] {
  if (classNode.type !== 'class_declaration' || classNode.namedChildren.some((c) => c.type === 'abstract_modifier')) return [];
  const symbol = input.symbols.symbols.find((s) => s.kind === 'class' && s.range.start.line === rangeOf(classNode).start.line);
  if (!symbol?.fqn) return [];
  // Méthodes concrètes de la hiérarchie (la classe elle-même comprise), puis méthodes abstraites qui manquent
  const concrete = new Set<string>();
  const abstract = new Map<string, PhpSymbol>();
  for (const owner of env.lookup.ancestors(symbol.fqn)) {
    const isInterface = owner.symbol.kind === 'interface';
    for (const child of owner.symbol.children ?? []) {
      if (child.kind !== 'method') continue;
      const key = child.name.toLowerCase();
      if (isInterface || child.modifiers?.includes('abstract')) {
        if (!abstract.has(key)) abstract.set(key, child);
      } else concrete.add(key);
    }
  }
  const missing = [...abstract.entries()].filter(([key]) => !concrete.has(key)).map(([, m]) => m);
  if (!missing.length) return [];
  const indent = indentOf(input.text, rangeOf(body).start.line) + '    ';
  const hasMembers = body.namedChildren.some((c) => c.type !== 'comment');
  const text = missing.map((m, i) => `${i > 0 || hasMembers ? '\n' : ''}${implementation(m, indent)}`).join('');
  return [action(l10n.t('Implement {0} missing methods', missing.length), input, [insert(rangeOf(body).end.line, text)])];
}

function phpdoc(input: GenerateInput, fn: Node): CodeAction[] {
  if (docComment(fn)) return [];
  const indent = indentOf(input.text, rangeOf(fn).start.line);
  const lines: string[] = [];
  for (const param of fn.childForFieldName('parameters')?.namedChildren ?? []) {
    const name = param.childForFieldName('name')?.text;
    if (!name) continue;
    const type = param.childForFieldName('type')?.text ?? 'mixed';
    lines.push(`@param ${type} ${param.type === 'variadic_parameter' ? '...' : ''}${name}`);
  }
  const name = fn.childForFieldName('name')?.text.toLowerCase();
  const returns = fn.childForFieldName('return_type')?.text;
  if (name !== '__construct' && returns !== 'void') lines.push(`@return ${returns ?? 'mixed'}`);
  if (!lines.length) return [];
  const doc = `${indent}/**\n${lines.map((l) => `${indent} * ${l}`).join('\n')}\n${indent} */\n`;
  return [action(l10n.t('Generate PHPDoc'), input, [insert(rangeOf(fn).start.line, doc)], CodeActionKind.RefactorRewrite)];
}

/** Type pour une phpdoc : classes en nom complet. */
function docType(type: TypeExpr): string | undefined {
  switch (type.kind) {
    case 'scalar':
      return type.name === 'null' ? undefined : type.name;
    case 'class':
      return `\\${type.fqn}`;
    case 'array':
      return type.value ? `${docType(type.value) ?? 'mixed'}[]` : 'array';
    case 'union': {
      const parts = type.types.map((t) => (t.kind === 'scalar' && t.name === 'null' ? 'null' : docType(t)));
      return parts.some((p) => p === undefined) ? undefined : parts.join('|');
    }
    default:
      return undefined;
  }
}

function varTag(input: GenerateInput, env: GenerateEnv, node: Node): CodeAction[] {
  const variable = ancestor(node, ['variable_name']);
  const assignment = variable?.parent;
  if (!variable || assignment?.type !== 'assignment_expression' || assignment.childForFieldName('left')?.id !== variable.id) return [];
  const statement = assignment.parent;
  if (statement?.type !== 'expression_statement') return [];
  const line = rangeOf(statement).start.line;
  if (/@var\b/.test(input.text.split('\n')[line - 1] ?? '')) return [];
  const type = env.resolver.expand(new Inferrer(input.symbols.scopes).expr(assignment.childForFieldName('right')), bindingAt(variable, input.symbols.scopes));
  const text = docType(type);
  if (!text) return [];
  const indent = indentOf(input.text, line);
  return [action(l10n.t('Add @var'), input, [insert(line, `${indent}/** @var ${text} ${variable.text} */\n`)], CodeActionKind.RefactorRewrite)];
}

export function generateActions(input: GenerateInput, range: Range, env: GenerateEnv): CodeAction[] {
  const node = nodeAt(input.tree, range);
  const out: CodeAction[] = [];
  out.push(...varTag(input, env, node));
  const fn = ancestor(node, ['method_declaration', 'function_definition']);
  if (fn && fn.childForFieldName('name') && rangeOf(fn.childForFieldName('name')!).start.line === range.start.line) out.push(...phpdoc(input, fn));
  const classNode = ancestor(node, ['class_declaration', 'trait_declaration']);
  const body = classNode?.childForFieldName('body');
  if (!classNode || !body || fn) return out;
  const property = ancestor(node, ['property_declaration']);
  const onProperty = property ? properties(body).find((p) => p.node.id === property.id) : undefined;
  if (onProperty) out.push(...accessors(input, env, body, onProperty.name));
  else out.push(...accessors(input, env, body));
  out.push(...constructor(input, env, body));
  out.push(...missingMethods(input, env, classNode, body));
  return out;
}
