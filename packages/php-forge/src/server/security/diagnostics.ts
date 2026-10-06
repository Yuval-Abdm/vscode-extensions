// Diagnostics de sécurité : chaque donnée de la requête qui atteint un point sensible, avec son chemin
// (« $_POST['id'] (line 12) → $id → $sql (line 20) → mysqli_query (line 21) »).
import * as l10n from '@vscode/l10n';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import { rangeOf } from '../model/ranges.ts';
import type { Tree } from '../parser/parser.ts';
import { analyzeTaint, SINK_CODES, type SinkKind, type Step, type TaintEnv } from './taint.ts';

function message(kind: SinkKind, path: string): string {
  switch (kind) {
    case 'sql':
      return l10n.t('Possible SQL injection: {0}', path);
    case 'xss':
      return l10n.t('Request data written to the page without escaping (XSS): {0}', path);
    case 'command':
      return l10n.t('Possible command injection: {0}', path);
    case 'include':
      return l10n.t('File inclusion controlled by the request: {0}', path);
    case 'unserialize':
      return l10n.t('unserialize() of request data: {0}', path);
    case 'redirect':
      return l10n.t('Redirect to an address controlled by the request: {0}', path);
    case 'path':
      return l10n.t('File path controlled by the request: {0}', path);
  }
}

/** Chemin lisible : la ligne n'est écrite que quand elle change (fichier compris pour une autre fonction). */
export function renderPath(steps: Step[], uri: string): string {
  let previous = '';
  return steps
    .map((s) => {
      const file = s.uri && s.uri !== uri ? `${decodeURIComponent(s.uri.slice(s.uri.lastIndexOf('/') + 1))}:` : '';
      const where = `${file}${s.line + 1}`;
      const shown = where === previous ? s.label : file ? `${s.label} (${where})` : l10n.t('{0} (line {1})', s.label, s.line + 1);
      previous = where;
      return shown;
    })
    .join(' → ');
}

export function securityDiagnostics(tree: Tree, env: TaintEnv): Diagnostic[] {
  return analyzeTaint(tree, env).map((f) => ({
    range: rangeOf(f.node),
    code: SINK_CODES[f.kind],
    severity: DiagnosticSeverity.Warning,
    source: 'PHP Forge',
    message: message(f.kind, renderPath(f.steps, env.uri)),
  }));
}
