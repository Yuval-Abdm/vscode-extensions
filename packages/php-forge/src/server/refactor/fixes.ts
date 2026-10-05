// Corrections rapides calculées sur l'arbre : déclarer une variable non définie (`$x = null;` au-dessus de
// l'instruction), remplacer l'appel d'une API supprimée ou dépréciée par le modèle des stubs.
import * as l10n from '@vscode/l10n';
import { CodeActionKind, type CodeAction, type Diagnostic } from 'vscode-languageserver/node';
import { rangeOf } from '../model/ranges.ts';
import type { Node, Tree } from '../parser/parser.ts';

const STATEMENT_PARENTS = new Set(['program', 'compound_statement', 'colon_block', 'case_statement', 'default_statement']);

/** Modèle des stubs appliqué aux arguments ; undefined quand il ne se traduit pas en code sûr. */
export function applyReplacement(template: string, args: string[]): string | undefined {
  if (template.includes('%class%')) return undefined;
  // Nom seul : même appel, autre fonction
  if (/^[A-Za-z_][\w\\]*$/.test(template)) return `${template}(${args.join(', ')})`;
  if (!/^[A-Za-z_][\w\\]*\(.*\)$/.test(template)) return undefined;
  let missing = false;
  const out = template
    .replace(/%parametersList%/g, () => args.join(', '))
    .replace(/%parameter(\d+)%/g, (_, i: string) => {
      const arg = args[Number(i)];
      if (arg === undefined) missing = true;
      return arg ?? '';
    });
  return missing ? undefined : out;
}

function statementOf(node: Node): Node | undefined {
  for (let n: Node | null = node; n?.parent; n = n.parent) if (STATEMENT_PARENTS.has(n.parent.type)) return n;
  return undefined;
}

function declare(uri: string, text: string, tree: Tree, d: Diagnostic, name: string): CodeAction[] {
  const node = tree.rootNode.namedDescendantForPosition({ row: d.range.start.line, column: d.range.start.character });
  const statement = node ? statementOf(node) : undefined;
  if (!statement || (statement.type === 'echo_statement' && statement.text.startsWith('<?='))) return [];
  const start = rangeOf(statement).start;
  const lineText = text.split('\n')[start.line] ?? '';
  const indent = lineText.slice(0, start.character);
  if (indent.trim() !== '') return [];
  const edit = { range: { start: { line: start.line, character: 0 }, end: { line: start.line, character: 0 } }, newText: `${indent}$${name} = null;\n` };
  return [{ title: l10n.t('Declare {0}', `$${name}`), kind: CodeActionKind.QuickFix, diagnostics: [d], edit: { changes: { [uri]: [edit] } } }];
}

function replace(uri: string, tree: Tree, d: Diagnostic, template: string): CodeAction[] {
  const node = tree.rootNode.namedDescendantForPosition({ row: d.range.start.line, column: d.range.start.character });
  let call: Node | null = node;
  while (call && call.type !== 'function_call_expression') call = call.parent;
  if (!call) return [];
  const args = (call.childForFieldName('arguments')?.namedChildren ?? []).filter((a) => a.type === 'argument').map((a) => a.text);
  const text = applyReplacement(template, args);
  if (!text) return [];
  return [{ title: l10n.t('Replace with {0}', text), kind: CodeActionKind.QuickFix, isPreferred: true, diagnostics: [d], edit: { changes: { [uri]: [{ range: rangeOf(call), newText: text }] } } }];
}

export function diagnosticFixes(uri: string, text: string, tree: Tree, diagnostics: Diagnostic[]): CodeAction[] {
  return diagnostics.flatMap((d) => {
    const data = (d.data ?? {}) as { variable?: string; replacement?: string };
    if ((d.code === 'undefined-variable' || d.code === 'maybe-undefined-variable') && data.variable) return declare(uri, text, tree, d, data.variable);
    if ((d.code === 'deprecated-api' || d.code === 'removed-api') && data.replacement) return replace(uri, tree, d, data.replacement);
    return [];
  });
}
