// CodeLens des déclarations : nombre de références (classes, fonctions, méthodes) et d'implémentations
// (interfaces, classes abstraites et leurs méthodes). Calculées à la demande (resolve), seulement pour les
// lentilles visibles.
import * as l10n from '@vscode/l10n';
import type { CodeLens, Location } from 'vscode-languageserver/node';
import type { FileSymbols, PhpSymbol, Position } from '../../shared/types.ts';
import { findReferences, targetAt, type RefEnv, type SourceFile } from './references.ts';

export interface LensSettings {
  references: boolean;
  implementations: boolean;
}

interface LensData {
  uri: string;
  line: number;
  character: number;
  kind: 'references' | 'implementations';
}

const REFERENCED = new Set(['class', 'interface', 'trait', 'enum', 'function', 'method']);

function abstractish(symbol: PhpSymbol, owner?: PhpSymbol): boolean {
  if (symbol.kind === 'interface') return true;
  if (symbol.kind === 'class' && symbol.modifiers?.includes('abstract')) return true;
  if (symbol.kind === 'method' && owner) return owner.kind === 'interface' || !!symbol.modifiers?.includes('abstract');
  return false;
}

export function symbolLenses(file: FileSymbols, settings: LensSettings): CodeLens[] {
  const out: CodeLens[] = [];
  const add = (symbol: PhpSymbol, owner?: PhpSymbol) => {
    if (!REFERENCED.has(symbol.kind) || symbol.virtual) return;
    const range = symbol.selectionRange;
    const data = (kind: LensData['kind']): LensData => ({ uri: file.uri, line: range.start.line, character: range.start.character, kind });
    if (settings.references) out.push({ range, data: data('references') });
    if (settings.implementations && abstractish(symbol, owner)) out.push({ range, data: data('implementations') });
  };
  for (const symbol of file.symbols) {
    add(symbol);
    for (const child of symbol.children ?? []) add(child, symbol);
  }
  return out;
}

export function resolveLens(env: RefEnv, lens: CodeLens, file: SourceFile, implementationsOf: (pos: Position) => Location[]): CodeLens {
  const data = lens.data as LensData;
  const position = { line: data.line, character: data.character };
  let locations: Location[] = [];
  if (data.kind === 'implementations') {
    locations = implementationsOf(position);
  } else {
    const target = targetAt(env, file, position);
    locations = target ? findReferences(env, target, false) : [];
  }
  const n = locations.length;
  const title = data.kind === 'implementations'
    ? (n === 1 ? l10n.t('1 implementation') : l10n.t('{0} implementations', n))
    : (n === 1 ? l10n.t('1 reference') : l10n.t('{0} references', n));
  return { ...lens, command: { title, command: 'phpForge.showReferences', arguments: [data.uri, position, locations] } };
}
