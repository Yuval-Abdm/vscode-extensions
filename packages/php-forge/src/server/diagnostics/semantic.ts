// Règles sur les symboles (§5.3) : fonctions, classes et constantes introuvables, API supprimées, trop récentes ou
// dépréciées pour la version de PHP du projet, méthodes et propriétés inexistantes sur un type connu, nombre
// d'arguments des fonctions et méthodes du projet. Prudentes avec le code historique : type inconnu, hiérarchie
// incomplète, méthodes magiques, @mixin ou garde function_exists / class_exists / defined → pas d'alerte.
import * as l10n from '@vscode/l10n';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import type { FileSymbols, PhpSymbol, Range } from '../../shared/types.ts';
import type { IndexedSymbol } from '../index/symbolIndex.ts';
import { enclosingClass } from '../model/context.ts';
import { writeTarget, writtenMember } from '../model/extract.ts';
import { resolveClassName, resolveFunctionOrConstant, scopeAt } from '../model/names.ts';
import { rangeOf } from '../model/ranges.ts';
import type { Node, Tree } from '../parser/parser.ts';
import { compareVersions, isAvailable } from '../stubs/availability.ts';
import { bindingAt, type TypeResolver } from '../types/expand.ts';
import { Inferrer } from '../types/infer.ts';
import { members } from '../types/type.ts';

const NAME_TYPES = new Set(['name', 'qualified_name', 'relative_name']);
/** Constructions du langage écrites comme des appels */
const LANGUAGE = new Set(['isset', 'empty', 'eval', 'die', 'exit', 'list', 'array', 'unset', 'echo', 'print', 'compact', 'extract']);
const NOT_CONSTANTS = new Set(['true', 'false', 'null', 'die', 'exit', '__dir__', '__file__', '__line__', '__function__', '__class__', '__method__', '__namespace__', '__trait__', '__compiler_halt_offset__']);
const CONSTANT_PARENTS = new Set([
  'echo_statement', 'return_statement', 'expression_statement', 'array_element_initializer', 'parenthesized_expression',
  'subscript_expression', 'unary_op_expression', 'sequence_expression', 'argument', 'conditional_expression', 'binary_expression',
  'assignment_expression', 'augmented_assignment_expression', 'cast_expression', 'pair', 'match_condition_list',
  'match_conditional_expression', 'match_default_expression', 'case_statement',
]);
const GUARDS: Record<string, 'function' | 'class' | 'constant'> = {
  function_exists: 'function',
  class_exists: 'class',
  interface_exists: 'class',
  trait_exists: 'class',
  enum_exists: 'class',
  defined: 'constant',
};
const SELF = new Set(['self', 'static', 'parent']);
const DYNAMIC_CLASSES = new Set(['stdclass']);

type Guards = Set<string>;

function diagnostic(range: Range, code: string, severity: DiagnosticSeverity, message: string): Diagnostic {
  return { range, code, severity, message, source: 'PHP Forge' };
}

/** Modèle de remplacement des stubs (fonctions) : correction « Replace with … ». */
function withReplacement(d: Diagnostic, symbol: PhpSymbol): Diagnostic {
  if (symbol.kind === 'function' && symbol.replacement) d.data = { ...(d.data as object | undefined), replacement: symbol.replacement };
  return d;
}

/** Nom inconnu porté par le diagnostic : imports proposés (« Import Lib\User », « Add include »). */
function withSymbol(d: Diagnostic, kind: 'class' | 'function' | 'constant', name: string): Diagnostic {
  d.data = { ...(d.data as object | undefined), symbol: { kind, name } };
  return d;
}

/** Noms garantis par une condition (function_exists('x'), class_exists('X'), defined('X'), combinés par &&). */
function guardNames(condition: Node | null | undefined): string[] {
  if (!condition) return [];
  if (condition.type === 'parenthesized_expression') return guardNames(condition.namedChildren[0]);
  if (condition.type === 'binary_expression') {
    const op = condition.childForFieldName('operator')?.type;
    return op === '&&' || op === 'and' ? [...guardNames(condition.childForFieldName('left')), ...guardNames(condition.childForFieldName('right'))] : [];
  }
  if (condition.type !== 'function_call_expression') return [];
  const fn = condition.childForFieldName('function')?.text.toLowerCase() ?? '';
  if (fn === 'method_exists' || fn === 'property_exists') {
    // method_exists($o, 'm') : le membre m de n'importe quel objet du bloc
    const member = condition.childForFieldName('arguments')?.namedChildren[1]?.namedChildren[0];
    return member?.type === 'string' || member?.type === 'encapsed_string' ? [`member:${member.text.slice(1, -1).toLowerCase()}`] : [];
  }
  const kind = GUARDS[fn];
  const arg = condition.childForFieldName('arguments')?.namedChildren[0]?.namedChildren[0];
  const value = arg && (arg.type === 'string' || arg.type === 'encapsed_string') ? arg.text.slice(1, -1).replace(/^\\+/, '').replace(/\\\\/g, '\\') : undefined;
  return kind && value ? [`${kind}:${value.toLowerCase()}`] : [];
}

class Checker {
  readonly out: Diagnostic[] = [];
  readonly #file: FileSymbols;
  readonly #resolver: TypeResolver;
  readonly #inferrer: Inferrer;
  readonly #known = new Map<string, boolean>();
  /** Propriétés écrites quelque part dans le fichier (`$u->extra = 1`) : leurs lectures ne sont pas signalées */
  readonly #written: Set<string>;

  constructor(file: FileSymbols, resolver: TypeResolver, written: Set<string>) {
    this.#file = file;
    this.#written = written;
    this.#resolver = resolver;
    this.#inferrer = new Inferrer(file.scopes);
  }

  get #version(): string | undefined {
    return this.#resolver.phpVersion;
  }

  visit(node: Node, guards: Guards): void {
    switch (node.type) {
      case 'if_statement': {
        const condition = node.childForFieldName('condition');
        this.visit(condition ?? node, guards);
        const inner = new Set([...guards, ...guardNames(condition)]);
        const body = node.childForFieldName('body');
        if (body) this.visit(body, inner);
        for (let i = 0; i < node.childCount; i++) if (node.fieldNameForChild(i) === 'alternative') this.visit(node.child(i)!, guards);
        return;
      }
      case 'binary_expression': {
        const op = node.childForFieldName('operator')?.type;
        if (op === 'instanceof') {
          // `$a instanceof X` : X n'a pas besoin d'exister
          const left = node.childForFieldName('left');
          if (left) this.visit(left, guards);
          return;
        }
        if (op === '&&' || op === 'and') {
          const left = node.childForFieldName('left');
          if (left) this.visit(left, guards);
          const right = node.childForFieldName('right');
          if (right) this.visit(right, new Set([...guards, ...guardNames(left)]));
          return;
        }
        break;
      }
      case 'function_call_expression':
        this.#call(node, guards);
        break;
      case 'object_creation_expression':
        this.#new(node, guards);
        break;
      case 'scoped_call_expression':
        this.#staticCall(node, guards);
        break;
      case 'class_constant_access_expression':
      case 'scoped_property_access_expression':
        this.#classReference(node.namedChildren[0], guards);
        break;
      case 'conditional_expression': {
        // `class_exists('X') ? new X() : null`
        const condition = node.childForFieldName('condition');
        if (condition) this.visit(condition, guards);
        const body = node.childForFieldName('body');
        if (body) this.visit(body, new Set([...guards, ...guardNames(condition)]));
        const alternative = node.childForFieldName('alternative');
        if (alternative) this.visit(alternative, guards);
        return;
      }
      case 'member_call_expression':
      case 'nullsafe_member_call_expression':
        if (!guards.has(`member:${node.childForFieldName('name')?.text.toLowerCase()}`)) this.#methodCall(node);
        break;
      case 'member_access_expression':
      case 'nullsafe_member_access_expression':
        if (!guards.has(`member:${node.childForFieldName('name')?.text.toLowerCase()}`)) this.#propertyRead(node);
        break;
      case 'assignment_expression':
      case 'augmented_assignment_expression':
      case 'reference_assignment_expression': {
        // Écriture d'une propriété : crée une propriété dynamique, pas d'alerte ; l'objet est visité
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (left && (left.type === 'member_access_expression' || left.type === 'nullsafe_member_access_expression')) {
          const object = left.childForFieldName('object');
          if (object) this.visit(object, guards);
        } else if (left) {
          this.visit(left, guards);
        }
        if (right) this.visit(right, guards);
        return;
      }
      case 'base_clause':
      case 'class_interface_clause':
        for (const name of node.namedChildren) if (NAME_TYPES.has(name.type)) this.#classReference(name, guards);
        return;
      case 'unset_statement':
        return;
      case 'encapsed_string':
      case 'heredoc_body':
        // "$a[key]" : la clé est une chaîne, pas une constante
        for (const child of node.namedChildren) this.visit(child.type === 'subscript_expression' ? child.namedChildren[0] : child, guards);
        return;
    }
    if (node.type === 'function_call_expression' && LANGUAGE.has(node.childForFieldName('function')?.text.toLowerCase() ?? '')) {
      // isset(), empty() : les accès à l'intérieur ne lèvent pas d'erreur
      const name = node.childForFieldName('function')?.text.toLowerCase();
      if (name === 'isset' || name === 'empty') return;
    }
    const label = node.type === 'argument' ? node.childForFieldName('name') : null;
    for (const child of node.namedChildren) {
      if (child.id === label?.id) continue;
      if (NAME_TYPES.has(child.type) && CONSTANT_PARENTS.has(node.type)) this.#constant(child, guards);
      else this.visit(child, guards);
    }
  }

  // ---- symboles globaux

  #call(node: Node, guards: Guards): void {
    const fn = node.childForFieldName('function');
    if (!fn || !NAME_TYPES.has(fn.type)) return;
    const text = fn.text;
    if (LANGUAGE.has(text.toLowerCase())) return;
    const scope = scopeAt(this.#file.scopes, rangeOf(fn).start);
    const candidates = resolveFunctionOrConstant(text, 'function', scope);
    const hits = this.#first(candidates, (n) => this.#resolver.lookup.findFunction(n));
    const short = text.replace(/^\\/, '');
    if (!hits.length) {
      if (guards.has(`function:${short.toLowerCase()}`) || candidates.some((c) => guards.has(`function:${c.toLowerCase()}`))) return;
      this.out.push(withSymbol(diagnostic(rangeOf(fn), 'undefined-function', DiagnosticSeverity.Error, l10n.t('Call to undefined function {0}()', short)), 'function', short));
      return;
    }
    const symbol = this.#api(hits, rangeOf(fn), `${short}()`);
    if (symbol && !hits[0].uri.startsWith('phpstub:') && hits.every((h) => h.symbol.params?.length === symbol.params?.length)) {
      this.#arguments(node, symbol, `${short}()`);
    }
  }

  #constant(name: Node, guards: Guards): void {
    const text = name.text;
    if (NOT_CONSTANTS.has(text.toLowerCase())) return;
    const candidates = resolveFunctionOrConstant(text, 'constant', scopeAt(this.#file.scopes, rangeOf(name).start));
    const hits = this.#first(candidates, (n) => this.#resolver.lookup.findConstant(n));
    if (!hits.length) {
      if (candidates.some((c) => guards.has(`constant:${c.toLowerCase()}`)) || guards.has(`constant:${text.toLowerCase()}`)) return;
      this.out.push(withSymbol(diagnostic(rangeOf(name), 'undefined-constant', DiagnosticSeverity.Error, l10n.t('Undefined constant {0}', text.replace(/^\\/, ''))), 'constant', text.replace(/^\\/, '')));
      return;
    }
    this.#api(hits, rangeOf(name), text.replace(/^\\/, ''));
  }

  /** Classe nommée (new, extends, X::…) : existence et disponibilité ; renvoie son nom complet si elle existe. */
  #classReference(name: Node | undefined, guards: Guards): string | undefined {
    if (!name || !NAME_TYPES.has(name.type)) return undefined;
    const lower = name.text.toLowerCase();
    if (SELF.has(lower)) return this.#selfClass(name, lower);
    const fqn = resolveClassName(name.text, scopeAt(this.#file.scopes, rangeOf(name).start));
    if (!fqn) return undefined;
    const hits = this.#resolver.lookup.findClass(fqn);
    if (!hits.length) {
      if (!guards.has(`class:${fqn.toLowerCase()}`) && !guards.has(`class:${lower.replace(/^\\/, '')}`)) {
        this.out.push(withSymbol(diagnostic(rangeOf(name), 'undefined-class', DiagnosticSeverity.Error, l10n.t('Class {0} does not exist', fqn)), 'class', name.text.slice(name.text.lastIndexOf('\\') + 1)));
      }
      return undefined;
    }
    this.#api(hits, rangeOf(name), fqn);
    return fqn;
  }

  #selfClass(node: Node, lower: string): string | undefined {
    const self = enclosingClass(node, this.#file.scopes);
    if (lower === 'parent') return self && this.#resolver.parentOf(self);
    return self;
  }

  /**
   * Disponibilité selon la version de PHP (stubs) : trop récent → undefined-function, supprimé → removed-api,
   * déprécié → deprecated-api. Renvoie la déclaration retenue.
   */
  #api(hits: IndexedSymbol[], range: Range, label: string): PhpSymbol | undefined {
    const version = this.#version;
    const available = hits.find((h) => isAvailable(h.symbol, version));
    if (!available) {
      const symbol = hits[0].symbol;
      if (version && symbol.since && compareVersions(symbol.since, version) > 0) {
        this.out.push(diagnostic(range, 'undefined-function', DiagnosticSeverity.Error, l10n.t('{0} is not available in PHP {1} (added in PHP {2})', label, version, symbol.since)));
      } else {
        const removed = symbol.removed ?? symbol.until;
        this.out.push(withReplacement(diagnostic(range, 'removed-api', DiagnosticSeverity.Error, l10n.t('{0} was removed in PHP {1}', label, removed ?? version ?? '')), symbol));
      }
      return symbol;
    }
    const symbol = available.symbol;
    if (symbol.deprecated && symbol.deprecatedSince && version && compareVersions(version, symbol.deprecatedSince) >= 0) {
      this.out.push(withReplacement(diagnostic(range, 'deprecated-api', DiagnosticSeverity.Warning, l10n.t('{0} is deprecated since PHP {1}', label, symbol.deprecatedSince)), symbol));
    }
    return symbol;
  }

  #first(candidates: string[], find: (name: string) => IndexedSymbol[]): IndexedSymbol[] {
    for (const candidate of candidates) {
      const hits = find(candidate);
      if (hits.length) return hits;
    }
    return [];
  }

  // ---- membres

  /** Hiérarchie entièrement connue (toutes les classes trouvées), sans @mixin. */
  #knownHierarchy(fqn: string): boolean {
    const key = fqn.toLowerCase();
    const cached = this.#known.get(key);
    if (cached !== undefined) return cached;
    let known = true;
    const seen = new Set<string>();
    const queue = [fqn];
    while (queue.length && known) {
      const name = queue.shift()!;
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const hits = this.#resolver.lookup.findClass(name);
      if (!hits.length || DYNAMIC_CLASSES.has(name.toLowerCase())) known = false;
      // Trait : `$this` est la classe hôte, inconnue ici
      if (name === fqn && hits.some((h) => h.symbol.kind === 'trait')) known = false;
      for (const hit of hits) {
        if (hit.symbol.mixins?.length || /AllowDynamicProperties/.test(hit.symbol.signature ?? '')) known = false;
        // Erreur de syntaxe dans le fichier : des membres ont pu être perdus par l'analyse
        if (this.#resolver.lookup.workspace.get(hit.uri)?.syntaxError) known = false;
        queue.push(...(hit.symbol.extends ?? []), ...(hit.symbol.implements ?? []), ...(hit.symbol.uses ?? []));
      }
    }
    this.#known.set(key, known);
    return known;
  }

  #hasMember(fqn: string, name: string, kinds: PhpSymbol['kind'][]): boolean {
    return this.#resolver.findMember({ fqn }, name, kinds).length > 0;
  }

  /** Classes de l'objet si son type est entièrement connu (aucune partie mixed ou non-objet inconnue). */
  #classesOf(object: Node): string[] {
    const type = this.#resolver.expand(this.#inferrer.expr(object), bindingAt(object, this.#file.scopes));
    const parts = members(type);
    if (!parts.length || parts.some((t) => t.kind === 'mixed')) return [];
    const classes = parts.flatMap((t) => (t.kind === 'class' ? [t.fqn] : []));
    return classes.every((fqn) => this.#knownHierarchy(fqn)) ? classes : [];
  }

  /** Classe (ou ancêtre) qui écrit `$this->$nom` : propriétés quelconques. */
  #dynamic(fqn: string): boolean {
    for (const hit of this.#resolver.lookup.ancestors(fqn)) if (hit.symbol.dynamic) return true;
    return false;
  }

  #methodCall(node: Node): void {
    const name = node.childForFieldName('name');
    const object = node.childForFieldName('object');
    if (!name || name.type !== 'name' || !object) return;
    const classes = this.#classesOf(object);
    if (!classes.length || classes.some((c) => this.#hasMember(c, '__call', ['method']))) return;
    const found = classes.map((fqn) => this.#resolver.findMember({ fqn }, name.text, ['method'])[0]);
    if (found.every((hit) => !hit)) {
      this.out.push(diagnostic(rangeOf(name), 'undefined-method', DiagnosticSeverity.Warning, l10n.t('Method {0}::{1}() does not exist', classes[0], name.text)));
      return;
    }
    const hit = found.find((h) => h);
    if (hit && !hit.owner.uri.startsWith('phpstub:')) this.#arguments(node, hit.member, `${hit.owner.symbol.name}::${hit.member.name}()`);
  }

  #staticCall(node: Node, guards: Guards): void {
    const scope = node.childForFieldName('scope');
    const name = node.childForFieldName('name');
    const fqn = scope?.type === 'relative_scope' ? this.#selfClass(scope, scope.text.toLowerCase()) : this.#classReference(scope ?? undefined, guards);
    if (!fqn || !name || name.type !== 'name' || !this.#knownHierarchy(fqn)) return;
    if (this.#hasMember(fqn, '__callStatic', ['method']) || this.#hasMember(fqn, '__call', ['method'])) return;
    const hit = this.#resolver.findMember({ fqn }, name.text, ['method'])[0];
    if (!hit) {
      this.out.push(diagnostic(rangeOf(name), 'undefined-method', DiagnosticSeverity.Warning, l10n.t('Method {0}::{1}() does not exist', fqn, name.text)));
      return;
    }
    if (!hit.owner.uri.startsWith('phpstub:')) this.#arguments(node, hit.member, `${hit.owner.symbol.name}::${hit.member.name}()`);
  }

  #new(node: Node, guards: Guards): void {
    const cls = node.namedChildren[0];
    const fqn = cls && NAME_TYPES.has(cls.type) ? this.#classReference(cls, guards) : undefined;
    if (!fqn) return;
    const ctor = this.#resolver.findMember({ fqn }, '__construct', ['method'])[0];
    if (ctor && !ctor.owner.uri.startsWith('phpstub:')) this.#arguments(node, ctor.member, `new ${cls.text}()`);
  }

  #propertyRead(node: Node): void {
    const name = node.childForFieldName('name');
    const object = node.childForFieldName('object');
    if (!name || name.type !== 'name' || !object) return;
    const classes = this.#classesOf(object);
    if (!classes.length || this.#written.has(name.text) || classes.some((c) => this.#hasMember(c, '__get', ['method']) || this.#dynamic(c))) return;
    if (classes.every((fqn) => !this.#hasMember(fqn, name.text, ['property']))) {
      this.out.push(diagnostic(rangeOf(name), 'undefined-property', DiagnosticSeverity.Warning, l10n.t('Property {0}::${1} does not exist', classes[0], name.text)));
    }
  }

  // ---- arguments

  #arguments(call: Node, symbol: PhpSymbol, label: string): void {
    if (symbol.variadicBody) return;
    const params = symbol.params ?? [];
    const list = call.childForFieldName('arguments') ?? call.namedChildren.find((c) => c.type === 'arguments');
    const args = (list?.namedChildren ?? []).filter((a) => a.type === 'argument' || a.type === 'variadic_unpacking');
    if (args.some((a) => a.type === 'variadic_unpacking' || a.childForFieldName('name') || a.namedChildren.some((c) => c.type === 'variadic_unpacking'))) return;
    const required = params.filter((p) => p.defaultValue === undefined && !p.variadic).length;
    const max = params.some((p) => p.variadic) ? Infinity : params.length;
    const range = rangeOf(list ?? call);
    if (args.length < required) {
      this.out.push(diagnostic(range, 'argument-count', DiagnosticSeverity.Error, l10n.t('Too few arguments to {0}: {1} given, at least {2} expected', label, args.length, required)));
    } else if (args.length > max) {
      this.out.push(diagnostic(range, 'argument-count', DiagnosticSeverity.Error, l10n.t('Too many arguments to {0}: {1} given, at most {2} expected', label, args.length, max)));
    }
  }
}

export function semanticDiagnostics(file: FileSymbols, tree: Tree, resolver: TypeResolver): Diagnostic[] {
  const checker = new Checker(file, resolver, writtenProperties(tree.rootNode));
  checker.visit(tree.rootNode, new Set());
  return checker.out.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
}

/** Noms des propriétés écrites dans le fichier, sur n'importe quel objet. */
function writtenProperties(root: Node): Set<string> {
  const out = new Set<string>();
  const visit = (node: Node): void => {
    const name = writtenMember(writeTarget(node))?.childForFieldName('name');
    if (name?.type === 'name') out.add(name.text);
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return out;
}
