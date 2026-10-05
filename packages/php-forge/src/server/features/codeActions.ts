// Corrections rapides liées aux diagnostics : ajout du « ; » manquant, corrections transportées par le diagnostic
// (balises PHP).
import * as l10n from '@vscode/l10n';
import { CodeActionKind, type CodeAction, type Diagnostic } from 'vscode-languageserver/node';
import { MISSING_SEMICOLON } from '../diagnostics/syntax.ts';
import type { DiagnosticFix } from '../diagnostics/tags.ts';

export function quickFixes(uri: string, diagnostics: Diagnostic[]): CodeAction[] {
  return diagnostics.flatMap((d): CodeAction[] => {
    if (d.code === MISSING_SEMICOLON) {
      return [action(uri, d, { title: l10n.t('Add ";"'), edits: [{ range: { start: d.range.end, end: d.range.end }, newText: ';' }] }, true)];
    }
    const fixes = (d.data as { fixes?: DiagnosticFix[] } | undefined)?.fixes ?? [];
    return fixes.map((fix, i) => action(uri, d, fix, i === 0));
  });
}

function action(uri: string, diagnostic: Diagnostic, fix: DiagnosticFix, isPreferred: boolean): CodeAction {
  return { title: fix.title, kind: CodeActionKind.QuickFix, isPreferred, diagnostics: [diagnostic], edit: { changes: { [uri]: fix.edits } } };
}
