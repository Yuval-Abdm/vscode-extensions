// Politique des diagnostics (§5.3) : dossiers librairie jamais diagnostiqués (motifs, dossiers Composer tiers),
// suppressions par commentaire (`// @php-forge-ignore <code>` sur la ligne ou la précédente,
// `/** @php-forge-ignore-file <code> */`), niveau réglable par règle, corrections rapides « ignorer ».
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import * as l10n from '@vscode/l10n';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import { isIndexable } from '../index/scan.ts';
import type { DiagnosticFix } from './tags.ts';

export type Level = 'error' | 'warning' | 'information' | 'hint' | 'off';

const SEVERITIES: Record<Exclude<Level, 'off'>, DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  information: DiagnosticSeverity.Information,
  hint: DiagnosticSeverity.Hint,
};
const SKIPPED_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '.vscode-test']);
const LINE_IGNORE = /@php-forge-ignore(?!-file)\b([^\n?*]*)/;
const FILE_IGNORE = /@php-forge-ignore-file\b([^\n*]*)/g;

/** Fichier d'une librairie : motif de `phpForge.libraryPaths` ou dossier qui a son propre composer.json. */
export function isLibrary(fsPath: string, roots: string[], patterns: string[], composerDirs: string[]): boolean {
  if (composerDirs.some((dir) => fsPath.startsWith(dir + path.sep))) return true;
  return roots.some((root) => fsPath.startsWith(root + path.sep) && !isIndexable(root, fsPath, patterns));
}

/** Dossiers (hors racine) qui contiennent un composer.json : paquets tiers copiés dans le projet. */
export async function findComposerDirs(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (dir !== root && entries.some((e) => e.isFile() && e.name === 'composer.json')) {
      out.push(dir);
      return;
    }
    for (const entry of entries) if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) await walk(path.join(dir, entry.name), depth + 1);
  };
  await walk(root, 0);
  return out.sort();
}

/** Codes d'un commentaire d'ignorance ; 'all' sans code. */
function codesOf(text: string): Set<string> | 'all' {
  const codes = text.match(/[a-z][\w-]*/gi) ?? [];
  return codes.length ? new Set(codes) : 'all';
}

const covers = (codes: Set<string> | 'all' | undefined, code: string) => codes === 'all' || !!codes?.has(code);

export function applyPolicy(diagnostics: Diagnostic[], text: string, rules: Record<string, Level>): Diagnostic[] {
  const lines = text.split('\n');
  let file: Set<string> | 'all' | undefined;
  for (const match of text.matchAll(FILE_IGNORE)) {
    const codes = codesOf(match[1]);
    file = codes === 'all' || file === 'all' ? 'all' : new Set([...(file ?? []), ...codes]);
  }
  const lineCodes = (line: number) => {
    const match = LINE_IGNORE.exec(lines[line] ?? '');
    return match ? codesOf(match[1]) : undefined;
  };
  const out: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const code = String(diagnostic.code ?? '');
    if (covers(file, code)) continue;
    const line = diagnostic.range.start.line;
    if (covers(lineCodes(line), code) || covers(lineCodes(line - 1), code)) continue;
    const level = rules[code];
    if (level === 'off') continue;
    out.push(level ? { ...diagnostic, severity: SEVERITIES[level] } : diagnostic);
  }
  return out;
}

/** Ligne dans du HTML (hors bloc PHP) : un commentaire PHP doit y être entouré de balises ; un fichier commence en HTML. */
function isHtmlLine(text: string, line: number): boolean {
  const before = text.split('\n').slice(0, line).join('\n');
  return before.lastIndexOf('?>') >= before.lastIndexOf('<?');
}

/** « Ignorer sur cette ligne » et « Ignorer dans ce fichier » pour un diagnostic. */
export function ignoreFixes(diagnostic: Diagnostic, text: string): DiagnosticFix[] {
  const code = String(diagnostic.code ?? '');
  if (!code) return [];
  const lines = text.split('\n');
  const line = diagnostic.range.start.line;
  const indent = /^\s*/.exec(lines[line] ?? '')?.[0] ?? '';
  const comment = `// @php-forge-ignore ${code}`;
  const lineText = isHtmlLine(text, line) ? `${indent}<?php ${comment} ?>\n` : `${indent}${comment}\n`;
  const first = lines.findIndex((l) => /<\?php\b/i.test(l));
  const fileComment = `/** @php-forge-ignore-file ${code} */`;
  const fileEdit = first >= 0 && lines[first].trim().toLowerCase() === '<?php'
    ? { range: { start: { line: first + 1, character: 0 }, end: { line: first + 1, character: 0 } }, newText: `${fileComment}\n` }
    : { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: `<?php ${fileComment} ?>\n` };
  return [
    { title: l10n.t('Ignore {0} on this line', code), edits: [{ range: { start: { line, character: 0 }, end: { line, character: 0 } }, newText: lineText }] },
    { title: l10n.t('Ignore {0} in this file', code), edits: [fileEdit] },
  ];
}
