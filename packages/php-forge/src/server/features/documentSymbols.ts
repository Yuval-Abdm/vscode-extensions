// Plan du fichier (outline, fil d'Ariane) : déclarations et membres.
import { SymbolTag, type DocumentSymbol } from 'vscode-languageserver/node';
import type { FileSymbols, PhpSymbol } from '../../shared/types.ts';
import { displayName, LSP_KIND } from './symbolKinds.ts';

export function documentSymbols(file: FileSymbols): DocumentSymbol[] {
  return file.symbols.map(toDocumentSymbol);
}

function toDocumentSymbol(symbol: PhpSymbol): DocumentSymbol {
  const result: DocumentSymbol = {
    name: displayName(symbol.kind, symbol.name),
    kind: LSP_KIND[symbol.kind],
    range: symbol.range,
    selectionRange: symbol.selectionRange,
  };
  if (symbol.deprecated) result.tags = [SymbolTag.Deprecated];
  if (symbol.children) result.children = symbol.children.map(toDocumentSymbol);
  return result;
}
