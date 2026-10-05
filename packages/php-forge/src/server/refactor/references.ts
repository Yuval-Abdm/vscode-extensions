// Références d'un symbole dans tout le projet. Les fichiers candidats sont ceux qui utilisent le nom
// (FileSymbols.names) ; chaque occurrence textuelle du nom y est vérifiée par la résolution (comme « aller à la
// définition »). Un membre appelé sur un objet de type inconnu n'est retenu que si son nom n'est déclaré qu'une
// fois dans le projet (sinon on ne sait pas de quelle classe il s'agit).
import type { Location } from 'vscode-languageserver/node';
import type { FileSymbols, PhpSymbol, Position, SymbolKind } from '../../shared/types.ts';
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
  if (!ref) return defineAt(file, pos);
  const declarations = resolveAt(env.lookup, file.symbols, file.tree, pos, env.resolver);
  if (!declarations.length) return undefined;
  const kind = ref.kind === 'member' ? MEMBER_KINDS[ref.member] : KIND_OF[declarations[0].symbol.kind];
  if (!kind) return undefined;
  if (ref.kind === 'member' && !knownOwner(env, file, ref)) {
    // Objet de type inconnu : seulement si le nom n'est déclaré qu'une fois, ni dans le projet ni par une classe de PHP
    if (declarations.length !== 1 || stubMembers(env).has(ref.name.toLowerCase())) return undefined;
  }
  const name = shortName(declarations[0].symbol.name);
  return { kind, name, declarations: kind === 'method' ? methodFamily(env, name, declarations) : declarations };
}

const inside = (r: { start: Position; end: Position }, pos: Position) =>
  (pos.line > r.start.line || (pos.line === r.start.line && pos.character >= r.start.character)) && (pos.line < r.end.line || (pos.line === r.end.line && pos.character <= r.end.character));

/** Nom d'une constante dans son `define('NOM', …)`. */
function defineAt(file: SourceFile, pos: Position): Target | undefined {
  const symbol = file.symbols.symbols.find((s) => s.kind === 'constant' && inside(s.selectionRange, pos));
  return symbol && { kind: 'constant', name: symbol.name, declarations: [{ uri: file.uri, symbol }] };
}

const stubMemberCache = new WeakMap<object, Set<string>>();

/** Noms (minuscules) des membres des classes de PHP. */
function stubMembers(env: RefEnv): Set<string> {
  let names = stubMemberCache.get(env.lookup.stubs);
  if (!names) {
    names = new Set();
    for (const file of env.lookup.stubs.files()) for (const symbol of file.symbols) for (const child of symbol.children ?? []) names.add(child.name.toLowerCase());
    stubMemberCache.set(env.lookup.stubs, names);
  }
  return names;
}

const CLASS_KINDS = new Set(['class', 'interface', 'trait', 'enum']);

/**
 * Méthode : toutes les déclarations reliées par la hiérarchie (méthode redéfinie, implémentée ou implémentant),
 * de proche en proche — renommer l'une sans les autres casserait le code.
 */
function methodFamily(env: RefEnv, name: string, declarations: IndexedSymbol[]): IndexedSymbol[] {
  const lower = name.toLowerCase();
  // Classes du projet et de PHP : parents directs et enfants directs
  const classes = new Map<string, { uri: string; symbol: PhpSymbol }[]>();
  const children = new Map<string, Set<string>>();
  for (const index of [env.lookup.workspace, env.lookup.stubs]) {
    for (const file of index.files()) {
      for (const symbol of file.symbols) {
        if (!CLASS_KINDS.has(symbol.kind) || !symbol.fqn) continue;
        const key = symbol.fqn.toLowerCase();
        classes.set(key, [...(classes.get(key) ?? []), { uri: file.uri, symbol }]);
        for (const parent of [...(symbol.extends ?? []), ...(symbol.implements ?? []), ...(symbol.uses ?? [])]) {
          const set = children.get(parent.toLowerCase()) ?? new Set();
          set.add(key);
          children.set(parent.toLowerCase(), set);
        }
      }
    }
  }
  const ownerOf = (d: IndexedSymbol) => {
    for (const [key, list] of classes) if (list.some((c) => c.uri === d.uri && c.symbol.children?.includes(d.symbol))) return key;
    return undefined;
  };
  const parentsOf = (key: string) => (classes.get(key) ?? []).flatMap(({ symbol }) => [...(symbol.extends ?? []), ...(symbol.implements ?? []), ...(symbol.uses ?? [])].map((p) => p.toLowerCase()));
  const declares = (key: string) => {
    for (const { uri, symbol } of classes.get(key) ?? []) {
      const method = symbol.children?.find((c) => c.kind === 'method' && c.name.toLowerCase() === lower);
      if (method) return { uri, symbol: method };
    }
    return undefined;
  };
  /** Classes atteintes depuis `start` en suivant `next` (start exclue). */
  const reach = (start: string, next: (key: string) => Iterable<string>) => {
    const seen = new Set([start]);
    const queue = [...next(start)];
    while (queue.length) {
      const key = queue.shift()!;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(...next(key));
    }
    seen.delete(start);
    return seen;
  };
  // Depuis chaque classe qui déclare la méthode : ses ancêtres qui la déclarent, ses descendants qui la redéfinissent
  const out = [...declarations];
  const done = new Set<string>();
  const queue = declarations.map(ownerOf).filter((k): k is string => !!k);
  while (queue.length) {
    const key = queue.shift()!;
    if (done.has(key)) continue;
    done.add(key);
    for (const other of [...reach(key, parentsOf), ...reach(key, (k) => children.get(k) ?? [])]) {
      const method = declares(other);
      if (!method) continue;
      if (!out.some((d) => d.symbol === method.symbol)) out.push(method);
      queue.push(other);
    }
  }
  return out;
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
    if (ref.kind === 'member' && !knownOwner(env, file, ref) && (hits.length !== 1 || stubMembers(env).has(ref.name.toLowerCase()))) continue;
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
