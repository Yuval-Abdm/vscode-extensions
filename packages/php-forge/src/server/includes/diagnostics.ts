// Diagnostics du moteur d'inclusion : variables non définies (règle stricte, avec les appelants fautifs), peut-être
// non définies, includes non résolus, symboles déclarés dans un fichier non inclus, analyse approximative.
import path from 'node:path';
import * as l10n from '@vscode/l10n';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import type { FileSymbols, Loc, Range } from '../../shared/types.ts';
import type { FileReport } from './analysis.ts';
import type { IncludeGraph } from './graph.ts';

const MAX_CALLERS = 3;

const rangeAt = (at: Loc, end: number): Range => ({ start: { line: at[0], character: at[1] }, end: { line: at[0], character: end } });

function diagnostic(range: Range, code: string, severity: DiagnosticSeverity, message: string): Diagnostic {
  return { range, code, severity, message, source: 'PHP Forge' };
}

/** « lp_3/index.php:12, landing_v6/index.php:40 (defined in 14 other callers) » ; vide pour un script seul. */
function callers(via: string[], others: number, label: (via: string) => string): string {
  const named = via.filter((v) => v !== '' && v !== 'function');
  if (!named.length) return '';
  let list = named.slice(0, MAX_CALLERS).map(label).join(', ');
  if (named.length > MAX_CALLERS) list = l10n.t('{0} and {1} more', list, named.length - MAX_CALLERS);
  if (others === 1) return l10n.t(' when included from {0} (defined in 1 other caller)', list);
  return others > 1 ? l10n.t(' when included from {0} (defined in {1} other callers)', list, others) : l10n.t(' when included from {0}', list);
}

export function includeDiagnostics(report: FileReport, file: FileSymbols, label: (via: string) => string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const read of report.reads) {
    const suffix = callers(read.via, read.others, label);
    if (read.kind === 'undefined') {
      out.push(diagnostic(rangeAt(read.at, read.end), 'undefined-variable', DiagnosticSeverity.Warning, l10n.t('{0} is not defined', `$${read.name}`) + suffix));
    } else {
      out.push(diagnostic(rangeAt(read.at, read.end), 'maybe-undefined-variable', DiagnosticSeverity.Information, l10n.t('{0} might not be defined', `$${read.name}`) + suffix));
    }
  }
  for (const unresolved of report.unresolved) {
    const ref = file.includes[unresolved.index];
    if (!ref) continue;
    const message = unresolved.evaluated
      ? l10n.t('Included file not found: {0}', ref.expression)
      : l10n.t('Include path could not be resolved: {0}. Add /** @include path */ on the line above to help.', ref.expression);
    out.push(diagnostic(ref.range, 'unresolved-include', DiagnosticSeverity.Information, message));
  }
  for (const { need, via, others } of report.symbols) {
    const where = need.declaredIn.map((uri) => label(`${uri}#file`)).join(', ');
    const message = l10n.t('{0} is declared in {1}, which is not included here', need.name, where) + callers(via, others, label);
    out.push({ ...diagnostic(rangeAt(need.at, need.end), 'symbol-not-included', DiagnosticSeverity.Warning, message), data: { declaredIn: need.declaredIn } });
  }
  for (const duplicate of report.duplicates) {
    const message = l10n.t('{0} is already declared in {1}', duplicate.name, label(`${duplicate.other}#file`)) + callers(duplicate.via, duplicate.others, label);
    out.push(diagnostic(duplicate.range, 'duplicate-declaration', DiagnosticSeverity.Error, message));
  }
  if (report.approximate) {
    out.push(diagnostic(rangeAt([0, 0], 0), 'include-analysis-approximate', DiagnosticSeverity.Information, l10n.t('Include analysis is approximate: this file is included in too many different contexts')));
  }
  return out;
}

/** Chemin relatif à la racine du workspace qui contient le fichier. */
export function relativePath(graph: IncludeGraph, uri: string): string {
  const fsPath = graph.fsPath(uri);
  const root = graph.roots.find((r) => fsPath.startsWith(r + path.sep)) ?? path.dirname(fsPath);
  return path.relative(root, fsPath).split(path.sep).join('/');
}

/** Libellé d'un appelant (« uri#ligne ») ou d'un fichier (« uri#file ») : « lp_3/index.php:12 » / « inc/x.php ». */
export function callerLabel(graph: IncludeGraph, via: string): string {
  const hash = via.lastIndexOf('#');
  if (hash < 0) return via;
  const file = relativePath(graph, via.slice(0, hash));
  const line = via.slice(hash + 1);
  return line === 'file' ? file : `${file}:${Number(line) + 1}`;
}
