// Migration de version PHP (§5.8) : avec `phpForge.migration.targetVersion`, tout ce qui casse ou devient déprécié
// entre la version du projet et la cible — API supprimées ou dépréciées (stubs), syntaxe (règles de
// deprecated-syntax évaluées à la cible), comparaisons nombre / chaîne de PHP 8.0, propriétés dynamiques de PHP 8.2.
// Ce qui est déjà signalé à la version du projet n'est pas répété. Corrections sûres : `each` dans un
// `while (list(…) = each(…))` → `foreach`, `create_function` aux arguments littéraux → closure, et celles de
// deprecated-syntax.
import * as l10n from '@vscode/l10n';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import type { FileSymbols, PhpSymbol, Range } from '../../shared/types.ts';
import { deprecatedSyntax } from '../diagnostics/deprecatedSyntax.ts';
import type { IndexedSymbol } from '../index/symbolIndex.ts';
import { resolveClassName, resolveFunctionOrConstant, scopeAt } from '../model/names.ts';
import type { DiagnosticFix } from '../diagnostics/tags.ts';
import { rangeOf } from '../model/ranges.ts';
import type { Node, Tree } from '../parser/parser.ts';
import { compareVersions, isAvailable } from '../stubs/availability.ts';
import type { TypeResolver } from '../types/expand.ts';

export const MIGRATION_REMOVED_API = 'migration-removed-api';
export const MIGRATION_DEPRECATED_API = 'migration-deprecated-api';
export const MIGRATION_SYNTAX = 'migration-syntax';
export const MIGRATION_BEHAVIOR = 'migration-behavior';
export const MIGRATION_DYNAMIC_PROPERTY = 'migration-dynamic-property';

const CODES: Record<string, string> = {
  'removed-api': MIGRATION_REMOVED_API,
  'deprecated-api': MIGRATION_DEPRECATED_API,
  'deprecated-syntax': MIGRATION_SYNTAX,
};

const REQUEST = /^\$_(?:GET|POST|REQUEST|COOKIE)$/;

export interface MigrationInput {
  symbols: FileSymbols;
  tree: Tree;
  text: string;
}

const key = (d: Diagnostic) => `${d.code}:${d.range.start.line}:${d.range.start.character}`;

/** Le passage de `from` à `to` franchit la version `at`. */
function crosses(from: string | undefined, to: string, at: string): boolean {
  return compareVersions(to, at) >= 0 && (!from || compareVersions(from, at) < 0);
}

/**
 * Diagnostics de migration. `current` : diagnostics déjà calculés à la version du projet (pas de doublon) ;
 * `target` : résolveur à la version cible.
 */
export function migrationDiagnostics(input: MigrationInput, current: Diagnostic[], resolver: TypeResolver, target: TypeResolver): Diagnostic[] {
  const to = target.phpVersion;
  const from = resolver.phpVersion;
  if (!to || (from && compareVersions(to, from) <= 0)) return [];
  const already = new Set(current.map(key));
  const later = [...apiChanges(input, target, from, to), ...deprecatedSyntax(input.tree, input.text, to)].filter((d) => !already.has(key(d)));
  const out: Diagnostic[] = later.map((d) => {
    const code = CODES[String(d.code)];
    const fixes = code === MIGRATION_REMOVED_API ? removedFixes(input.tree, d.range) : [];
    const data = fixes.length ? { ...(d.data as object | undefined), fixes } : d.data;
    return {
      ...d,
      code,
      severity: code === MIGRATION_DEPRECATED_API ? DiagnosticSeverity.Information : DiagnosticSeverity.Warning,
      message: l10n.t('PHP {0}: {1}', to, String(d.message)),
      ...(data ? { data } : {}),
    };
  });
  if (crosses(from, to, '8.0')) out.push(...comparisons(input.tree));
  if (crosses(from, to, '8.2')) out.push(...dynamicProperties(input, target));
  return out.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
}

const NAME_TYPES = new Set(['name', 'qualified_name', 'relative_name']);

/**
 * API natives (fonctions appelées, classes instanciées) disponibles à la version du projet mais supprimées ou
 * dépréciées à la cible. Seule la disponibilité change avec la version : pas de seconde analyse sémantique complète.
 */
function apiChanges(input: MigrationInput, target: TypeResolver, from: string | undefined, to: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const lookup = target.lookup;
  const check = (hits: IndexedSymbol[], node: Node, label: string) => {
    const now = hits.find((h) => isAvailable(h.symbol, from));
    if (!now || !now.uri.startsWith('phpstub:')) return;
    const later = hits.find((h) => isAvailable(h.symbol, to));
    const symbol = now.symbol;
    const data = symbol.kind === 'function' && symbol.replacement ? { replacement: symbol.replacement } : undefined;
    const range = rangeOf(node);
    if (!later) {
      const removed = symbol.removed ?? symbol.until ?? to;
      out.push({ range, code: 'removed-api', severity: DiagnosticSeverity.Error, source: 'PHP Forge', message: l10n.t('{0} was removed in PHP {1}', label, removed), ...(data ? { data } : {}) });
    } else if (later.symbol.deprecated && later.symbol.deprecatedSince && compareVersions(to, later.symbol.deprecatedSince) >= 0 && !(from && compareVersions(from, later.symbol.deprecatedSince) >= 0)) {
      out.push({ range, code: 'deprecated-api', severity: DiagnosticSeverity.Warning, source: 'PHP Forge', message: l10n.t('{0} is deprecated since PHP {1}', label, later.symbol.deprecatedSince), ...(data ? { data } : {}) });
    }
  };
  for (const node of input.tree.rootNode.descendantsOfType(['function_call_expression', 'object_creation_expression'])) {
    const name = node.type === 'function_call_expression' ? node.childForFieldName('function') : node.namedChildren.find((c) => NAME_TYPES.has(c.type));
    if (!name || !NAME_TYPES.has(name.type)) continue;
    const scope = scopeAt(input.symbols.scopes, rangeOf(name).start);
    if (node.type === 'function_call_expression') {
      const hits = resolveFunctionOrConstant(name.text, 'function', scope).map((n) => lookup.findFunction(n)).find((h) => h.length) ?? [];
      if (hits.length) check(hits, name, `${name.text.replace(/^\\/, '')}()`);
    } else {
      const fqn = resolveClassName(name.text, scope);
      if (fqn) check(lookup.findClass(fqn), name, fqn);
    }
  }
  return out;
}

/** PHP 8.0 compare un nombre et une chaîne non numérique comme des chaînes (`0 == "a"` devient faux). */
function comparisons(tree: Tree): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const node of tree.rootNode.descendantsOfType('binary_expression')) {
    const operator = node.childForFieldName('operator')?.type;
    if (operator !== '==' && operator !== '!=' && operator !== '<>') continue;
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if (!left || !right) continue;
    const [number, other] = isNumber(left) ? [left, right] : isNumber(right) ? [right, left] : [];
    if (!number || !other || !maybeText(other)) continue;
    out.push({
      range: rangeOf(node),
      code: MIGRATION_BEHAVIOR,
      severity: DiagnosticSeverity.Information,
      source: 'PHP Forge',
      message: l10n.t('PHP 8.0: a number compared with a non-numeric string is now compared as a string ({0})', node.text.length <= 60 ? node.text : `${node.text.slice(0, 57)}…`),
    });
  }
  return out;
}

function isNumber(node: Node): boolean {
  if (node.type === 'integer' || node.type === 'float') return true;
  return node.type === 'unary_op_expression' && /^[-+]$/.test(node.child(0)?.text ?? '') && isNumber(node.namedChildren[0]);
}

/** Chaîne qui peut ne pas être numérique : littéral non numérique, ou valeur de la requête. */
function maybeText(node: Node): boolean {
  if (node.type === 'string' || node.type === 'encapsed_string') {
    const text = node.text.slice(1, -1);
    return node.namedChildren.every((c) => c.type === 'string_content' || c.type === 'escape_sequence') && !/^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(text);
  }
  let base: Node | null = node;
  while (base?.type === 'subscript_expression') base = base.namedChildren[0];
  return base?.type === 'variable_name' && REQUEST.test(base.text) && node !== base;
}

/** Propriétés créées sans déclaration (`$this->x = …`) : dépréciées en PHP 8.2 sauf #[AllowDynamicProperties] ou __set. */
function dynamicProperties(input: MigrationInput, target: TypeResolver): Diagnostic[] {
  const out: Diagnostic[] = [];
  const classes = input.tree.rootNode.descendantsOfType('class_declaration');
  const visit = (symbols: PhpSymbol[]) => {
    for (const cls of symbols) {
      if (cls.kind !== 'class') continue;
      const node = classes.find((c) => c.startPosition.row === cls.range.start.line && c.childForFieldName('name')?.text === cls.name);
      const allowed = node?.namedChildren.some((c) => c.type === 'attribute_list' && /\bAllowDynamicProperties\b/.test(c.text));
      const fqn = cls.fqn ?? cls.name;
      const magic = target.lookup.findMembers(fqn, '__set', ['method']).length > 0;
      const parents = (cls.extends ?? []).some((p) => p.toLowerCase() === 'stdclass');
      if (allowed || magic || parents) continue;
      for (const prop of cls.children ?? []) {
        if (prop.kind !== 'property' || !prop.dynamic) continue;
        // Déclarée par un parent : pas dynamique
        const declared = (cls.extends ?? []).some((parent) => target.lookup.findMembers(parent, prop.name, ['property']).some((m) => !m.symbol.dynamic));
        if (declared) continue;
        out.push({
          range: prop.selectionRange,
          code: MIGRATION_DYNAMIC_PROPERTY,
          severity: DiagnosticSeverity.Warning,
          source: 'PHP Forge',
          message: l10n.t('PHP 8.2: the dynamic property {0}::${1} is deprecated; declare it in the class', cls.name, prop.name),
        });
      }
    }
  };
  visit(input.symbols.symbols);
  return out;
}

/** Corrections sûres d'une API supprimée : each() en boucle while, create_function aux arguments littéraux. */
function removedFixes(tree: Tree, range: Range): DiagnosticFix[] {
  let call: Node | null = tree.rootNode.descendantForPosition({ row: range.start.line, column: range.start.character });
  while (call && call.type !== 'function_call_expression') call = call.parent;
  if (!call) return [];
  const name = call.childForFieldName('function')?.text.replace(/^\\/, '').toLowerCase();
  if (name === 'each') return eachFix(call);
  if (name === 'create_function') return createFunctionFix(call);
  return [];
}

const args = (call: Node) => (call.childForFieldName('arguments')?.namedChildren ?? []).filter((a) => a.type === 'argument').map((a) => a.namedChildren[a.namedChildren.length - 1]);

/** `while (list($k, $v) = each($a))` → `foreach ($a as $k => $v)` ; `list(, $v)` → `foreach ($a as $v)`. */
function eachFix(call: Node): DiagnosticFix[] {
  const assignment = call.parent;
  const list = assignment?.childForFieldName('left');
  const condition = assignment?.parent;
  const loop = condition?.parent;
  if (assignment?.type !== 'assignment_expression' || list?.type !== 'list_literal' || condition?.type !== 'parenthesized_expression' || loop?.type !== 'while_statement') return [];
  const [array] = args(call);
  const vars = list.namedChildren.filter((c) => c.type === 'variable_name');
  if (!array || vars.length === 0 || vars.length > 2 || list.namedChildren.length !== vars.length) return [];
  const skipsKey = /^list\s*\(\s*,/i.test(list.text);
  const target = vars.length === 2 ? `${vars[0].text} => ${vars[1].text}` : skipsKey ? vars[0].text : '';
  if (!target || (vars.length === 2 && skipsKey)) return [];
  const header = `foreach (${array.text} as ${target})`;
  const range = { start: rangeOf(loop).start, end: rangeOf(condition).end };
  return [{ title: l10n.t('Replace with {0}', header), edits: [{ range, newText: header }] }];
}

/** `create_function('$a, $b', 'return $a + $b;')` → `function ($a, $b) { return $a + $b; }` (chaînes simples seulement). */
function createFunctionFix(call: Node): DiagnosticFix[] {
  const [params, body] = args(call);
  if (params?.type !== 'string' || body?.type !== 'string' || !params.text.startsWith("'") || !body.text.startsWith("'")) return [];
  const unquote = (s: string) => s.slice(1, -1).replace(/\\(['\\])/g, '$1');
  const list = unquote(params.text).split(',').map((p) => p.trim()).filter(Boolean).join(', ');
  const code = unquote(body.text).trim();
  const closure = `function (${list}) { ${code} }`;
  return [{ title: l10n.t('Replace with a closure'), edits: [{ range: rangeOf(call), newText: closure }] }];
}
