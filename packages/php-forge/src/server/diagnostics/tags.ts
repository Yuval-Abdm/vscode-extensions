// Balises PHP dans du HTML :
// - `<?php $nom ?>` / `<?$nom?>` : une valeur seule entre deux balises n'est jamais affichée, il manque `<?=` ou `echo` ;
// - `<?` : balise courte, ne fonctionne qu'avec short_open_tag activé.
import * as l10n from '@vscode/l10n';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import type { Range } from '../../shared/types.ts';
import { rangeOf } from '../model/ranges.ts';
import type { Node, Tree } from '../parser/parser.ts';

export const USELESS_OUTPUT = 'useless-output';
export const SHORT_OPEN_TAG = 'short-open-tag';

/** Correction proposée, transportée dans `Diagnostic.data` et rendue par les actions de code. */
export interface DiagnosticFix {
  title: string;
  edits: { range: Range; newText: string }[];
}

/** Expressions sans effet : les évaluer sans les afficher ne sert à rien. */
const PURE = new Set([
  'variable_name', 'name', 'qualified_name', 'string', 'string_content', 'encapsed_string', 'escape_sequence', 'integer', 'float',
  'boolean', 'null', 'member_access_expression', 'nullsafe_member_access_expression', 'subscript_expression',
  'scoped_property_access_expression', 'class_constant_access_expression', 'binary_expression', 'parenthesized_expression',
  'conditional_expression', 'unary_op_expression', 'cast_expression', 'cast_type', 'array_creation_expression', 'array_element_initializer',
]);

/** `text` : texte du document (pas `rootNode.text`, qui omet les lignes vides du début). */
export function tagDiagnostics(tree: Tree, text: string): Diagnostic[] {
  const tags = tree.rootNode.descendantsOfType(['php_tag', 'php_end_tag']);
  const out: Diagnostic[] = [];
  tags.forEach((tag, i) => {
    if (tag.type !== 'php_tag') return;
    const opening = /^<\?(?:php|=)?/i.exec(text.slice(tag.startIndex, tag.startIndex + 5))?.[0] ?? '<?';
    if (opening === '<?=') return;
    const start = rangeOf(tag).start;
    const tagRange: Range = { start, end: { line: start.line, character: start.character + opening.length } };
    const next = tags[i + 1];
    const value = next?.type === 'php_end_tag' ? loneValue(tree, text, tag.startIndex + opening.length, next.startIndex) : undefined;
    if (value) {
      const valueStart = rangeOf(value).start;
      out.push(warning({ start, end: rangeOf(value).end }, USELESS_OUTPUT, l10n.t('Value not displayed: did you mean "<?="?'), [
        { title: l10n.t('Replace with "{0}"', '<?='), edits: [{ range: tagRange, newText: '<?=' }] },
        { title: l10n.t('Replace with "{0}"', '<?php echo'), edits: [{ range: { start, end: valueStart }, newText: '<?php echo ' }] },
      ]));
    } else if (opening === '<?' && !/^xml/i.test(text.slice(tag.startIndex + 2, tag.startIndex + 5))) {
      const spaced = /\s/.test(text[tag.startIndex + 2] ?? ' ');
      out.push(warning(tagRange, SHORT_OPEN_TAG, l10n.t('Short open tag "<?" only works with short_open_tag enabled: use "<?php" or "<?="'), [
        { title: l10n.t('Replace with "{0}"', '<?php'), edits: [{ range: tagRange, newText: spaced ? '<?php' : '<?php ' }] },
      ]));
    }
  });
  return out;
}

/** Instruction unique entre `from` et `to`, si c'est une expression sans effet. */
function loneValue(tree: Tree, text: string, from: number, to: number): Node | undefined {
  const first = from + (/^\s*/.exec(text.slice(from, to))?.[0].length ?? 0);
  if (first >= to) return undefined;
  let statement = tree.rootNode.namedDescendantForIndex(first);
  if (!statement) return undefined;
  while (statement.parent && statement.parent.startIndex >= from && statement.parent.endIndex <= to) statement = statement.parent;
  if (statement.type !== 'expression_statement' || statement.startIndex !== first || statement.hasError) return undefined;
  if (!/^[\s;]*$/.test(text.slice(statement.endIndex, to))) return undefined;
  const value = statement.namedChildren[0];
  return value && pure(value) ? value : undefined;
}

function pure(node: Node): boolean {
  return PURE.has(node.type) && node.namedChildren.every(pure);
}

function warning(range: Range, code: string, message: string, fixes: DiagnosticFix[]): Diagnostic {
  return { range, message, severity: DiagnosticSeverity.Warning, source: 'PHP Forge', code, data: { fixes } };
}
