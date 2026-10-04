// Aller à la définition : déclarations du workspace (les stubs n'ont pas de fichier à ouvrir).
import type { Location } from 'vscode-languageserver/node';
import type { FileSymbols, Position } from '../../shared/types.ts';
import type { Lookup } from '../index/lookup.ts';
import type { Tree } from '../parser/parser.ts';
import { resolveAt } from './resolve.ts';

export function definition(lookup: Lookup, file: FileSymbols, tree: Tree, pos: Position): Location[] {
  return resolveAt(lookup, file, tree, pos)
    .filter((hit) => !hit.uri.startsWith('phpstub:'))
    .map((hit) => ({ uri: hit.uri, range: hit.symbol.selectionRange }));
}
