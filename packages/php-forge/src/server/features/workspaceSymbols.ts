// Recherche de symboles dans tout le workspace (Ctrl+T) : correspondance floue sur le nom court.
import type { SymbolInformation } from 'vscode-languageserver/node';
import type { PhpSymbol } from '../../shared/types.ts';
import type { SymbolIndex } from '../index/symbolIndex.ts';
import { displayName, LSP_KIND } from './symbolKinds.ts';

/** Score de correspondance (nom et requête en minuscules) : 0 si aucune. */
export function matchScore(name: string, query: string): number {
  if (name === query) return 100;
  if (name.startsWith(query)) return 80;
  if (name.includes(query)) return 60;
  let i = 0;
  for (const ch of name) if (ch === query[i] && ++i === query.length) return 20;
  return 0;
}

const namespaceOf = (fqn?: string) => (fqn?.includes('\\') ? fqn.slice(0, fqn.lastIndexOf('\\')) : undefined);

export function workspaceSymbols(index: SymbolIndex, query: string, limit = 256): SymbolInformation[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: { score: number; info: SymbolInformation }[] = [];
  const consider = (uri: string, symbol: PhpSymbol, container?: string) => {
    const score = matchScore(symbol.name.toLowerCase(), q);
    if (!score) return;
    const info: SymbolInformation = {
      name: displayName(symbol.kind, symbol.name),
      kind: LSP_KIND[symbol.kind],
      location: { uri, range: symbol.selectionRange },
    };
    const containerName = container ?? namespaceOf(symbol.fqn);
    if (containerName) info.containerName = containerName;
    hits.push({ score, info });
  };
  for (const file of index.files()) {
    for (const symbol of file.symbols) {
      consider(file.uri, symbol);
      for (const child of symbol.children ?? []) consider(file.uri, child, symbol.fqn ?? symbol.name);
    }
  }
  return hits
    .sort((a, b) => b.score - a.score || a.info.name.localeCompare(b.info.name))
    .slice(0, limit)
    .map((h) => h.info);
}
