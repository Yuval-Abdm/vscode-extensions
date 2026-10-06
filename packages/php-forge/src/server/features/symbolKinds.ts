// Correspondance des types de symboles PHP Forge → LSP.
import { SymbolKind } from 'vscode-languageserver/node';
import type { SymbolKind as PhpSymbolKind } from '../../shared/types.ts';

export const LSP_KIND: Record<PhpSymbolKind, SymbolKind> = {
  class: SymbolKind.Class,
  interface: SymbolKind.Interface,
  trait: SymbolKind.Class,
  enum: SymbolKind.Enum,
  function: SymbolKind.Function,
  method: SymbolKind.Method,
  property: SymbolKind.Property,
  constant: SymbolKind.Constant,
  classConstant: SymbolKind.Constant,
  enumCase: SymbolKind.EnumMember,
};

/** Nom affiché : les propriétés gardent leur « $ ». */
export const displayName = (kind: PhpSymbolKind, name: string) => (kind === 'property' ? `$${name}` : name);
