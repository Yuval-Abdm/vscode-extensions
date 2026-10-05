// Références d'un symbole dans tout le projet. Les fichiers candidats sont ceux qui utilisent le nom
// (FileSymbols.names) ; chaque occurrence textuelle du nom y est vérifiée par la résolution (comme « aller à la
// définition »). Un membre appelé sur un objet de type inconnu n'est retenu que si son nom n'est déclaré qu'une
// fois dans le projet (sinon on ne sait pas de quelle classe il s'agit).
import type { Location } from 'vscode-languageserver/node';
import type { FileSymbols, Position, SymbolKind } from '../../shared/types.ts';
import type { IncludeGraph } from '../includes/graph.ts';
import type { Lookup } from '../index/lookup.ts';
import type { IndexedSymbol } from '../index/symbolIndex.ts';
import { nameAt, type Reference } from '../features/nameAt.ts';
import { ownerReceivers, resolveAt } from '../features/resolve.ts';
import type { Tree } from '../parser/parser.ts';
import type { TypeResolver } from '../types/expand.ts';
import { stringReference } from './strings.ts';

export interface SourceFile {
  uri: string;
  text: string;
  tree: Tree;
  symbols: FileSymbols;
}

export interface RefEnv {
  lookup: Lookup;
  resolver: TypeResolver;
  files(): FileSymbols[];
  /** Document ouvert, ou fichier lu et analysé pour la recherche (`release` libère alors son arbre) */
  source(uri: string): { file: SourceFile; release(): void } | undefined;
  /** Graphe d'inclusion (variables du niveau fichier partagées par la chaîne) */
  graph?: IncludeGraph;
}

export type TargetKind = 'class' | 'function' | 'constant' | 'method' | 'property' | 'classConstant';

export interface Target {
  kind: TargetKind;
  /** Nom court, sans « $ » ni namespace */
  name: string;
  declarations: IndexedSymbol[];
}

const MEMBER_KINDS: Record<string, TargetKind> = { method: 'method', property: 'property', classConstant: 'classConstant' };
const KIND_OF: Partial<Record<SymbolKind, TargetKind>> = {
  class: 'class', interface: 'class', trait: 'class', enum: 'class', function: 'function', constant: 'constant',
  method: 'method', property: 'property', classConstant: 'classConstant', enumCase: 'classConstant',
};
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Conversion index → position avec une table des débuts de ligne. */
export function positionsOf(text: string): (index: number) => Position {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: index - starts[lo] };
  };
}

const sameDeclaration = (a: IndexedSymbol, b: IndexedSymbol) =>
  a.uri === b.uri && a.symbol.selectionRange.start.line === b.symbol.selectionRange.start.line && a.symbol.selectionRange.start.character === b.symbol.selectionRange.start.character;

function shortName(name: string): string {
  const clean = name.replace(/^\\/, '').replace(/^\$/, '');
  return clean.slice(clean.lastIndexOf('\\') + 1);
}

/** Symbole désigné à une position (déclaration ou utilisation). */
export function targetAt(env: RefEnv, file: SourceFile, pos: Position): Target | undefined {
  const ref = nameAt(file.tree, pos);
  if (!ref) return undefined;
  const declarations = resolveAt(env.lookup, file.symbols, file.tree, pos, env.resolver);
  if (!declarations.length) return undefined;
  const kind = ref.kind === 'member' ? MEMBER_KINDS[ref.member] : KIND_OF[declarations[0].symbol.kind];
  if (!kind) return undefined;
  if (ref.kind === 'member' && !knownOwner(env, file, ref)) {
    // Objet de type inconnu : seulement si le nom n'est déclaré qu'une fois
    if (declarations.length !== 1) return undefined;
  }
  return { kind, name: shortName(declarations[0].symbol.name), declarations };
}

function knownOwner(env: RefEnv, file: SourceFile, ref: Reference): boolean {
  return ref.kind !== 'member' || ownerReceivers(ref.owner, ref.node, file.symbols, env.resolver).length > 0;
}

function matches(ref: Reference, target: Target): boolean {
  if (ref.kind === 'member') return MEMBER_KINDS[ref.member] === target.kind;
  return ref.kind === target.kind;
}

/** Occurrences du nom de `target` dans un fichier, vérifiées. */
export function referencesIn(env: RefEnv, file: SourceFile, target: Target, includeDeclaration: boolean): Location[] {
  const caseless = target.kind === 'class' || target.kind === 'function' || target.kind === 'method';
  // Propriété : la déclaration et l'accès statique s'écrivent `$name`
  const before = target.kind === 'property' ? '(?<!\\w)' : '(?<![\\w$])';
  const pattern = new RegExp(`${before}${escape(target.name)}(?!\\w)`, caseless ? 'gi' : 'g');
  const at = positionsOf(file.text);
  const out: Location[] = [];
  for (const match of file.text.matchAll(pattern)) {
    const pos = at(match.index);
    const end = { line: pos.line, character: pos.character + target.name.length };
    const ref = nameAt(file.tree, target.kind === 'property' && file.text[match.index - 1] === '$' ? { line: pos.line, character: pos.character - 1 } : pos);
    if (!ref || !matches(ref, target)) {
      const inString = stringReference(env, file, target, match.index);
      if (inString) out.push({ uri: file.uri, range: inString });
      continue;
    }
    const hits = resolveAt(env.lookup, file.symbols, file.tree, pos, env.resolver);
    if (!hits.some((hit) => target.declarations.some((d) => sameDeclaration(d, hit)))) continue;
    if (ref.kind === 'member' && !knownOwner(env, file, ref) && hits.length !== 1) continue;
    const declaration = target.declarations.some((d) => d.uri === file.uri && d.symbol.selectionRange.start.line === pos.line && Math.abs(d.symbol.selectionRange.start.character - pos.character) <= 1);
    if (declaration && !includeDeclaration) continue;
    out.push({ uri: file.uri, range: { start: pos, end } });
  }
  return out;
}

/** Références dans tout le projet. */
export function findReferences(env: RefEnv, target: Target, includeDeclaration: boolean): Location[] {
  const key = target.name.toLowerCase();
  const out: Location[] = [];
  for (const symbols of env.files()) {
    if (symbols.uri.startsWith('phpstub:') || !symbols.names?.includes(key)) continue;
    const source = env.source(symbols.uri);
    if (!source) continue;
    try {
      out.push(...referencesIn(env, source.file, target, includeDeclaration));
    } finally {
      source.release();
    }
  }
  return out;
}
