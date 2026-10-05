// Syntaxe dépréciée ou supprimée selon la version de PHP du projet (§5.3 deprecated-syntax), avec correction
// quand elle est sûre. `$s{0}` n'est pas analysable par tree-sitter : reconnu dans le texte des lignes, il remplace
// les erreurs de syntaxe qu'il provoque.
import * as l10n from '@vscode/l10n';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import type { Range } from '../../shared/types.ts';
import { rangeOf } from '../model/ranges.ts';
import type { Node, Tree } from '../parser/parser.ts';
import { compareVersions } from '../stubs/availability.ts';
import type { DiagnosticFix } from './tags.ts';

export const DEPRECATED_SYNTAX = 'deprecated-syntax';
const BRACE_OFFSET = /(\$\w+(?:\[[^\]\n]*\])*)\{([^{}\n]+)\}/g;

interface Rule {
  deprecated: string;
  removed?: string;
}

const RULES = {
  braceOffset: { deprecated: '7.4', removed: '8.0' },
  realCast: { deprecated: '7.4', removed: '8.0' },
  unsetCast: { deprecated: '7.2', removed: '8.0' },
  nestedTernary: { deprecated: '7.4', removed: '8.0' },
  dollarBrace: { deprecated: '8.2' },
  implicitNullable: { deprecated: '8.4' },
  php4Constructor: { deprecated: '7.0', removed: '8.0' },
} satisfies Record<string, Rule>;

function applies(rule: Rule, version: string | undefined): boolean {
  return !version || compareVersions(version, rule.deprecated) >= 0;
}

/** « … est dépréciée depuis PHP x » ou « … supprimée en PHP y » selon la version. */
function message(what: string, rule: Rule, version: string | undefined, advice?: string): string {
  const removed = rule.removed && (!version || compareVersions(version, rule.removed) >= 0);
  const base = removed ? l10n.t('{0} was removed in PHP {1}', what, rule.removed!) : l10n.t('{0} is deprecated since PHP {1}', what, rule.deprecated);
  return advice ? `${base}: ${advice}` : base;
}

function warning(range: Range, text: string, fixes: DiagnosticFix[] = []): Diagnostic {
  return { range, code: DEPRECATED_SYNTAX, severity: DiagnosticSeverity.Warning, message: text, source: 'PHP Forge', data: { fixes } };
}

export function deprecatedSyntax(tree: Tree, text: string, version: string | undefined): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (tree.rootNode.hasError && applies(RULES.braceOffset, version)) braceOffsets(text, version, out);
  const visit = (node: Node, namespaced: boolean): void => {
    switch (node.type) {
      case 'cast_expression': {
        const type = node.childForFieldName('type');
        const cast = type?.text.replace(/\s+/g, '').toLowerCase();
        if (type && cast === 'real' && applies(RULES.realCast, version)) {
          out.push(warning(rangeOf(type), message(l10n.t('The {0} cast', '(real)'), RULES.realCast, version, l10n.t('use {0}', '(float)')), [{ title: l10n.t('Replace with {0}', '(float)'), edits: [{ range: rangeOf(type), newText: 'float' }] }]));
        } else if (cast === 'unset' && applies(RULES.unsetCast, version)) {
          out.push(warning(rangeOf(node), message(l10n.t('The {0} cast', '(unset)'), RULES.unsetCast, version, l10n.t('use {0}', 'null'))));
        }
        break;
      }
      case 'conditional_expression': {
        const condition = node.childForFieldName('condition');
        if (condition?.type === 'conditional_expression' && applies(RULES.nestedTernary, version)) {
          out.push(warning(rangeOf(node), message(l10n.t('A nested ternary without parentheses'), RULES.nestedTernary, version, l10n.t('add parentheses'))));
        }
        break;
      }
      case 'dynamic_variable_name':
        if (applies(RULES.dollarBrace, version) && (node.parent?.type === 'encapsed_string' || node.parent?.type === 'heredoc_body')) dollarBrace(node, version, out);
        break;
      case 'simple_parameter':
        if (applies(RULES.implicitNullable, version)) implicitNullable(node, version, out);
        break;
      case 'class_declaration':
        if (!namespaced && applies(RULES.php4Constructor, version)) php4Constructor(node, version, out);
        break;
      case 'namespace_definition':
        for (const child of node.namedChildren) visit(child, true);
        return;
    }
    for (const child of node.namedChildren) visit(child, namespaced);
  };
  const root = tree.rootNode;
  const namespaced = root.namedChildren.some((c) => c.type === 'namespace_definition');
  for (const child of root.namedChildren) visit(child, namespaced);
  return out.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
}

function braceOffsets(text: string, version: string | undefined, out: Diagnostic[]): void {
  text.split('\n').forEach((line, row) => {
    for (const match of line.matchAll(BRACE_OFFSET)) {
      const start = match.index!;
      const range: Range = { start: { line: row, character: start }, end: { line: row, character: start + match[0].length } };
      const fixed = `${match[1]}[${match[2]}]`;
      const d = warning(range, message(l10n.t('A string offset with braces {0}', match[0]), RULES.braceOffset, version, l10n.t('use {0}', fixed)), [{ title: l10n.t('Replace with {0}', fixed), edits: [{ range, newText: fixed }] }]);
      (d.data as { braceOffset?: boolean }).braceOffset = true;
      out.push(d);
    }
  });
}

function dollarBrace(node: Node, version: string | undefined, out: Diagnostic[]): void {
  const inner = node.namedChildren[0];
  const range = rangeOf(node);
  const fixes: DiagnosticFix[] = [];
  // `${var}` → `{$var}` ; `${tab['k']}` → `{$tab['k']}` ; `${expr}` (variable variable) : pas de correction sûre
  if (inner?.type === 'name') fixes.push({ title: l10n.t('Replace with {0}', `{$${inner.text}}`), edits: [{ range, newText: `{$${inner.text}}` }] });
  else if (inner?.type === 'subscript_expression' && inner.namedChildren[0]?.type === 'name') fixes.push({ title: l10n.t('Replace with {0}', `{$${inner.text}}`), edits: [{ range, newText: `{$${inner.text}}` }] });
  out.push(warning(range, message(l10n.t('The {0} string interpolation', '${…}'), RULES.dollarBrace, version, l10n.t('use {0}', '{$…}')), fixes));
}

function implicitNullable(param: Node, version: string | undefined, out: Diagnostic[]): void {
  const type = param.childForFieldName('type');
  const value = param.childForFieldName('default_value');
  if (!type || value?.type !== 'null') return;
  const range = rangeOf(type);
  const label = `${type.text} ${param.childForFieldName('name')?.text ?? ''}`;
  if (type.type === 'named_type' || type.type === 'primitive_type') {
    out.push(warning(range, message(l10n.t('An implicitly nullable parameter {0}', label), RULES.implicitNullable, version, l10n.t('use {0}', `?${type.text}`)), [
      { title: l10n.t('Replace with {0}', `?${type.text}`), edits: [{ range: { start: range.start, end: range.start }, newText: '?' }] },
    ]));
  } else if (type.type === 'union_type' && !type.namedChildren.some((c) => c.text.toLowerCase() === 'null')) {
    out.push(warning(range, message(l10n.t('An implicitly nullable parameter {0}', label), RULES.implicitNullable, version, l10n.t('use {0}', `${type.text}|null`)), [
      { title: l10n.t('Replace with {0}', `${type.text}|null`), edits: [{ range: { start: range.end, end: range.end }, newText: '|null' }] },
    ]));
  }
}

function php4Constructor(cls: Node, version: string | undefined, out: Diagnostic[]): void {
  const name = cls.childForFieldName('name')?.text.toLowerCase();
  const methods = (cls.childForFieldName('body')?.namedChildren ?? []).filter((m) => m.type === 'method_declaration');
  if (!name || methods.some((m) => m.childForFieldName('name')?.text.toLowerCase() === '__construct')) return;
  const old = methods.find((m) => m.childForFieldName('name')?.text.toLowerCase() === name);
  const nameNode = old?.childForFieldName('name');
  if (nameNode) out.push(warning(rangeOf(nameNode), message(l10n.t('A PHP 4 constructor'), RULES.php4Constructor, version, l10n.t('use {0}', '__construct()'))));
}

/** Lignes où un offset entre accolades a été reconnu : leurs erreurs de syntaxe viennent de lui. */
export function braceOffsetLines(diagnostics: Diagnostic[]): Set<number> {
  return new Set(diagnostics.filter((d) => (d.data as { braceOffset?: boolean } | undefined)?.braceOffset).map((d) => d.range.start.line));
}
