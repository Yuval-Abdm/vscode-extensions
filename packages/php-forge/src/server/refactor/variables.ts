// Variables : occurrences dans leur portée (fonction, méthode, closure) ; pour une variable du niveau fichier, dans
// tous les fichiers de sa chaîne d'inclusion (appelants et fichiers inclus), avec `global $x` et `$GLOBALS['x']`
// dans les fonctions — jamais les variables locales homonymes.
import type { Location } from 'vscode-languageserver/node';
import type { Position, Range } from '../../shared/types.ts';
import { variableAt } from '../features/nameAt.ts';
import { ALWAYS_DEFINED } from '../includes/program.ts';
import { rangeOf } from '../model/ranges.ts';
import type { Node } from '../parser/parser.ts';
import { scopeRoot } from '../types/flow.ts';
import { positionsOf, type RefEnv, type SourceFile } from './references.ts';

export interface VariableTarget {
  /** Nom sans « $ » */
  name: string;
  uri: string;
  fileLevel: boolean;
  root: Node;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function variableTarget(file: SourceFile, pos: Position): VariableTarget | undefined {
  const node = variableAt(file.tree, pos);
  if (!node) return undefined;
  const name = node.text.slice(1);
  if (ALWAYS_DEFINED.has(name)) return undefined;
  const root = scopeRoot(node);
  return { name, uri: file.uri, fileLevel: root.type === 'program', root };
}

const nameRange = (node: Node): Range => {
  const range = rangeOf(node);
  return { start: { line: range.start.line, character: range.start.character + 1 }, end: range.end };
};

/** `$name` dans la portée `root` (sans entrer dans les fonctions imbriquées). */
function inScope(file: SourceFile, root: Node, name: string): Range[] {
  const at = positionsOf(file.text);
  const out: Range[] = [];
  for (const match of file.text.slice(root.startIndex, root.endIndex).matchAll(new RegExp(`\\$${escape(name)}(?!\\w)`, 'g'))) {
    const index = root.startIndex + match.index;
    const node = variableAt(file.tree, at(index));
    if (!node || node.startIndex !== index || scopeRoot(node).id !== root.id) continue;
    out.push(nameRange(node));
  }
  return out;
}

/** Fonctions du fichier qui importent la variable par `global $name`, et `$GLOBALS['name']`. */
function globals(file: SourceFile, name: string): Range[] {
  const out: Range[] = [];
  for (const declaration of file.tree.rootNode.descendantsOfType('global_declaration')) {
    if (!declaration.namedChildren.some((v) => v.text === `$${name}`)) continue;
    out.push(...inScope(file, scopeRoot(declaration), name));
  }
  for (const subscript of file.tree.rootNode.descendantsOfType('subscript_expression')) {
    const [base, key] = subscript.namedChildren;
    if (base?.text !== '$GLOBALS' || !key || (key.type !== 'string' && key.type !== 'encapsed_string') || key.text.slice(1, -1) !== name) continue;
    const range = rangeOf(key);
    out.push({ start: { line: range.start.line, character: range.start.character + 1 }, end: { line: range.end.line, character: range.end.character - 1 } });
  }
  return out;
}

/** Fichiers reliés par inclusion (appelants et inclus, de proche en proche). */
function chain(env: RefEnv, uri: string): string[] {
  const graph = env.graph;
  if (!graph) return [uri];
  const seen = new Set([uri]);
  const queue = [uri];
  while (queue.length) {
    const current = queue.shift()!;
    const next = [...graph.includersOf(current).map((s) => s.from), ...graph.sitesOf(current).flatMap((s) => (s.target ? [s.target] : []))];
    for (const other of next) {
      if (seen.has(other)) continue;
      seen.add(other);
      queue.push(other);
    }
  }
  return [...seen];
}

export function variableReferences(env: RefEnv, file: SourceFile, target: VariableTarget): Location[] {
  if (!target.fileLevel) return inScope(file, target.root, target.name).map((range) => ({ uri: file.uri, range }));
  const out: Location[] = [];
  for (const uri of chain(env, file.uri)) {
    const source = uri === file.uri ? { file, release: () => undefined } : env.source(uri);
    if (!source) continue;
    try {
      const ranges = [...inScope(source.file, source.file.tree.rootNode, target.name), ...globals(source.file, target.name)];
      for (const range of ranges) out.push({ uri, range });
    } finally {
      source.release();
    }
  }
  return out;
}
