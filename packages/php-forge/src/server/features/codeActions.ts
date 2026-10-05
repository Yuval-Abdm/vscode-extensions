// Corrections rapides liées aux diagnostics : ajout du « ; » manquant.
import * as l10n from '@vscode/l10n';
import { CodeActionKind, type CodeAction, type Diagnostic } from 'vscode-languageserver/node';
import { MISSING_SEMICOLON } from '../diagnostics/syntax.ts';

export function quickFixes(uri: string, diagnostics: Diagnostic[]): CodeAction[] {
  return diagnostics
    .filter((d) => d.code === MISSING_SEMICOLON)
    .map((d) => ({
      title: l10n.t('Add ";"'),
      kind: CodeActionKind.QuickFix,
      isPreferred: true,
      diagnostics: [d],
      edit: { changes: { [uri]: [{ range: { start: d.range.end, end: d.range.end }, newText: ';' }] } },
    }));
}
