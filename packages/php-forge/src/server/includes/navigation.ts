// Navigation dans les inclusions : appelants et fichiers inclus (vue, commande), CodeLens « Included by N files »,
// aller à la définition depuis l'expression d'un include.
import * as l10n from '@vscode/l10n';
import type { CodeLens, Location } from 'vscode-languageserver/node';
import type { IncludeLink } from '../../shared/protocol.ts';
import type { FileSymbols, Position } from '../../shared/types.ts';
import { contains } from '../model/ranges.ts';
import { relativePath } from './diagnostics.ts';
import type { IncludeGraph } from './graph.ts';

export function includerLinks(graph: IncludeGraph, uri: string): IncludeLink[] {
  return graph.includersOf(uri)
    .filter((site) => site.from !== uri)
    .map((site) => ({ uri: site.from, line: site.line, label: `${relativePath(graph, site.from)}:${site.line + 1}` }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

export function includeLinks(graph: IncludeGraph, uri: string): IncludeLink[] {
  const seen = new Set<string>();
  const out: IncludeLink[] = [];
  for (const site of graph.sitesOf(uri)) {
    if (!site.target || seen.has(site.target)) continue;
    seen.add(site.target);
    out.push({ uri: site.target, line: 0, label: relativePath(graph, site.target) });
  }
  return out;
}

export function includersLens(graph: IncludeGraph, uri: string): CodeLens[] {
  const count = new Set(graph.includersOf(uri).filter((site) => site.from !== uri).map((site) => site.from)).size;
  if (!count) return [];
  const title = count === 1 ? l10n.t('Included by 1 file') : l10n.t('Included by {0} files', count);
  return [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, command: { title, command: 'phpForge.showIncluders', arguments: [uri] } }];
}

export function includeDefinition(graph: IncludeGraph, file: FileSymbols, pos: Position): Location[] {
  const index = file.includes.findIndex((ref) => contains(ref.range, pos));
  const target = index >= 0 ? graph.sitesOf(file.uri)[index]?.target : undefined;
  return target ? [{ uri: target, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }] : [];
}
