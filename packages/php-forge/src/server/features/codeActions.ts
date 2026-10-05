// Corrections rapides liées aux diagnostics : ajout du « ; » manquant, corrections transportées par le diagnostic
// (balises PHP).
import * as l10n from '@vscode/l10n';
import { CodeActionKind, type CodeAction, type Diagnostic } from 'vscode-languageserver/node';
import { ignoreFixes } from '../diagnostics/policy.ts';
import { MISSING_SEMICOLON } from '../diagnostics/syntax.ts';
import type { DiagnosticFix } from '../diagnostics/tags.ts';

/** `text` : texte du document, pour les corrections « ignorer » (absent : seulement les corrections du diagnostic). */
export function quickFixes(uri: string, diagnostics: Diagnostic[], text?: string): CodeAction[] {
  return diagnostics.flatMap((d): CodeAction[] => {
    const own = d.code === MISSING_SEMICOLON
      ? [action(uri, d, { title: l10n.t('Add ";"'), edits: [{ range: { start: d.range.end, end: d.range.end }, newText: ';' }] }, true)]
      : ((d.data as { fixes?: DiagnosticFix[] } | undefined)?.fixes ?? []).map((fix, i) => action(uri, d, fix, i === 0));
    const ignore = text !== undefined && d.source === 'PHP Forge' ? ignoreFixes(d, text).map((fix) => action(uri, d, fix, false)) : [];
    return [...own, ...ignore];
  });
}

function action(uri: string, diagnostic: Diagnostic, fix: DiagnosticFix, isPreferred: boolean): CodeAction {
  return { title: fix.title, kind: CodeActionKind.QuickFix, isPreferred, diagnostics: [diagnostic], edit: { changes: { [uri]: fix.edits } } };
}
