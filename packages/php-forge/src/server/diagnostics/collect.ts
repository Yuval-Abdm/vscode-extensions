// Diagnostics d'un fichier (document ouvert ou fichier du disque) : erreurs locales (syntaxe, balises, guillemets
// mélangés), inclusions, règles sémantiques (calculées à part : coûteuses pendant la frappe), puis politique
// (librairie, suppressions, niveaux) et baseline.
import type { Diagnostic } from 'vscode-languageserver/node';
import type { FileSymbols } from '../../shared/types.ts';
import type { IncludeAnalysis } from '../includes/analysis.ts';
import { callerLabel, includeDiagnostics } from '../includes/diagnostics.ts';
import type { Parser, Tree } from '../parser/parser.ts';
import { mixedQuoteDiagnostics, sqlQuoteDiagnostics } from '../sql/quotes.ts';
import type { TypeResolver } from '../types/expand.ts';
import type { Baseline } from './baseline.ts';
import { codeDiagnostics } from './code.ts';
import { braceOffsetLines, deprecatedSyntax } from './deprecatedSyntax.ts';
import { applyPolicy, type Level } from './policy.ts';
import { semanticDiagnostics } from './semantic.ts';
import { syntaxDiagnostics } from './syntax.ts';
import { tagDiagnostics } from './tags.ts';

export interface CollectInput {
  uri: string;
  fsPath: string;
  symbols: FileSymbols;
  tree: Tree;
  text: string;
}

export interface CollectEnv {
  parser: Parser;
  resolver: TypeResolver;
  analysis?: IncludeAnalysis;
  rules: Record<string, Level>;
  library: (fsPath: string) => boolean;
  baseline: (fsPath: string) => { baseline: Baseline; rel: string } | undefined;
  /** Diagnostics d'inclusion fournis par l'appelant (documents ouverts : décalés au fil de la frappe) */
  includes?: (input: CollectInput) => Diagnostic[] | undefined;
}

const byPosition = (a: Diagnostic, b: Diagnostic) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character;

/** Règles sémantiques, code mort et syntaxe dépréciée. */
export function semanticPart(input: CollectInput, env: CollectEnv): Diagnostic[] {
  if (env.library(input.fsPath)) return [];
  return [
    ...semanticDiagnostics(input.symbols, input.tree, env.resolver),
    ...codeDiagnostics(input.tree),
    ...deprecatedSyntax(input.tree, input.text, env.resolver.phpVersion),
  ];
}

/** `raw` : après la politique, avant la baseline (pour créer la baseline) ; `hidden` : alertes masquées par elle. */
export function collectDiagnostics(input: CollectInput, env: CollectEnv, semantic: Diagnostic[]): { diagnostics: Diagnostic[]; raw: Diagnostic[]; hidden: number } {
  if (env.library(input.fsPath)) return { diagnostics: [], raw: [], hidden: 0 };
  const braces = braceOffsetLines(input.tree, input.text);
  const syntax = syntaxDiagnostics(input.tree, 100, { parser: env.parser, text: input.text }).filter((d) => !braces.has(d.range.start.line));
  const all = [...syntax, ...tagDiagnostics(input.tree, input.text), ...sqlQuoteDiagnostics(input.tree), ...mixedQuoteDiagnostics(input.tree), ...semantic];
  const provided = env.includes?.(input);
  if (provided) all.push(...provided);
  else {
    const report = env.analysis?.report(input.uri);
    if (env.analysis && report) {
      const graph = env.analysis.graph;
      all.push(...includeDiagnostics(report, input.symbols, (via) => callerLabel(graph, via)));
    }
  }
  const raw = applyPolicy(all, input.text, env.rules).sort(byPosition);
  const base = env.baseline(input.fsPath);
  if (!base) return { diagnostics: raw, raw, hidden: 0 };
  const { kept, hidden } = base.baseline.filter(base.rel, raw, input.text);
  return { diagnostics: kept, raw, hidden };
}
