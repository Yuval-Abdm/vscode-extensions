// Aller à la définition : déclarations du workspace (les stubs n'ont pas de fichier à ouvrir).
import type { Location } from 'vscode-languageserver/node';
import type { FileSymbols, Position } from '../../shared/types.ts';
import type { Lookup } from '../index/lookup.ts';
import type { Tree } from '../parser/parser.ts';
import type { TypeResolver } from '../types/expand.ts';
import { externalFor } from '../types/external.ts';
import { variableAt } from './nameAt.ts';
import { resolveAt } from './resolve.ts';

export function definition(lookup: Lookup, file: FileSymbols, tree: Tree, pos: Position, resolver?: TypeResolver): Location[] {
  const hits = resolveAt(lookup, file, tree, pos, resolver)
    .filter((hit) => !hit.uri.startsWith('phpstub:'))
    .map((hit) => ({ uri: hit.uri, range: hit.symbol.selectionRange }));
  if (hits.length) return hits;
  // Variable : son affectation, y compris dans un fichier inclus
  const variable = variableAt(tree, pos);
  const origin = variable && externalFor(file.scopes)?.variable(variable.text.slice(1), pos)?.origin;
  return origin ? [{ uri: origin.uri, range: { start: { line: origin.line, character: 0 }, end: { line: origin.line, character: 0 } } }] : [];
}
