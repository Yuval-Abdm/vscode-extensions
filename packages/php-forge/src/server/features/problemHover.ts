// Survol d'une ligne qui a des erreurs ou avertissements : le problème, la correction proposée et un lien qui
// l'applique d'un clic (commande du client, seule autorisée dans les liens du survol).
import * as l10n from '@vscode/l10n';
import { DiagnosticSeverity, type Diagnostic, type Hover, type TextEdit } from 'vscode-languageserver/node';
import { quickFixes } from './codeActions.ts';

export const APPLY_FIX_COMMAND = 'phpForge.applyFix';

export interface ApplyFixArgs {
  uri: string;
  /** Version du document pour laquelle la correction a été calculée : ignorée si le document a changé depuis */
  version: number;
  edits: TextEdit[];
}

/** `version` : version du document dont viennent les diagnostics. */
export function problemsMarkdown(uri: string, version: number, diagnostics: Diagnostic[], line: number): string | undefined {
  const onLine = diagnostics.filter((d) => d.range.start.line <= line && line <= d.range.end.line);
  if (onLine.length === 0) return undefined;
  // Un même problème signalé à plusieurs endroits (morceaux d'une requête) : une seule fois
  const seen = new Set<string>();
  const unique = onLine.filter((d) => {
    const key = JSON.stringify([d.message, quickFixes(uri, [d]).map((f) => [f.title, f.edit])]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique
    .map((d) => {
      const icon = d.severity === DiagnosticSeverity.Error ? '❌' : d.severity === DiagnosticSeverity.Warning ? '⚠️' : 'ℹ️';
      const message = typeof d.message === 'string' ? d.message : d.message.value;
      const lines = [`${icon} ${escape(message)}`];
      for (const fix of quickFixes(uri, [d])) {
        const args: ApplyFixArgs[] = [{ uri, version, edits: fix.edit?.changes?.[uri] ?? [] }];
        const link = `command:${APPLY_FIX_COMMAND}?${encodeURIComponent(JSON.stringify(args))}`;
        lines.push(`💡 ${escape(fix.title)} — [${l10n.t('Apply')}](${link})`);
      }
      return lines.join('  \n');
    })
    .join('\n\n');
}

/** Survol existant complété par les problèmes de la ligne. */
export function withProblems(hover: Hover | null, problems: string | undefined): Hover | null {
  if (!problems) return hover;
  if (!hover) return { contents: { kind: 'markdown', value: problems } };
  const contents = hover.contents as { kind: string; value: string };
  return { ...hover, contents: { kind: 'markdown', value: `${contents.value}\n\n---\n\n${problems}` } };
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()<>#+!|]/g, (c) => `\\${c}`);
}
