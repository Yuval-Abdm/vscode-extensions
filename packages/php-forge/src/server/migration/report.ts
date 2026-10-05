// Rapport de migration (commande « Migration report ») : diagnostics migration-* du workspace, par règle et par
// fichier, en Markdown.
import * as l10n from '@vscode/l10n';

export interface ReportFile {
  /** Chemin relatif au dossier du workspace */
  path: string;
  problems: { line: number; code: string; message: string }[];
}

export function migrationReport(files: ReportFile[], from: string | undefined, to: string): string {
  const withProblems = files.filter((f) => f.problems.length).sort((a, b) => b.problems.length - a.problems.length || a.path.localeCompare(b.path));
  const total = withProblems.reduce((n, f) => n + f.problems.length, 0);
  const out = [`# ${l10n.t('Migration report: PHP {0} → PHP {1}', from ?? '?', to)}`, ''];
  if (!total) return [...out, l10n.t('No problem found.'), ''].join('\n');
  out.push(l10n.t('{0} problems in {1} files.', total, withProblems.length), '', `## ${l10n.t('By rule')}`, '', `| ${l10n.t('Rule')} | ${l10n.t('Problems')} | ${l10n.t('Files')} |`, '|---|---:|---:|');
  const rules = new Map<string, { problems: number; files: Set<string> }>();
  for (const file of withProblems) {
    for (const p of file.problems) {
      const rule = rules.get(p.code) ?? { problems: 0, files: new Set<string>() };
      rule.problems++;
      rule.files.add(file.path);
      rules.set(p.code, rule);
    }
  }
  for (const [code, rule] of [...rules].sort((a, b) => b[1].problems - a[1].problems || a[0].localeCompare(b[0]))) out.push(`| \`${code}\` | ${rule.problems} | ${rule.files.size} |`);
  out.push('', `## ${l10n.t('By file')}`);
  for (const file of withProblems) {
    out.push('', `### ${file.path} (${file.problems.length})`, '');
    for (const p of [...file.problems].sort((a, b) => a.line - b.line)) out.push(`- ${l10n.t('line {0}', p.line + 1)} — \`${p.code}\` — ${p.message.replace(/\n/g, ' ')}`);
  }
  return `${out.join('\n')}\n`;
}

/**
 * Problèmes de chaque fichier du workspace, en rendant la main au serveur tous les `every` fichiers (complétion,
 * survol et diagnostics continuent pendant un rapport sur des milliers de fichiers).
 */
export async function collectReport(uris: Iterable<string>, problems: (uri: string) => ReportFile | undefined, pause: () => Promise<void>, every = 20): Promise<ReportFile[]> {
  const out: ReportFile[] = [];
  let count = 0;
  for (const uri of uris) {
    if (count > 0 && count % every === 0) await pause();
    count++;
    const file = problems(uri);
    if (file?.problems.length) out.push(file);
  }
  return out;
}
