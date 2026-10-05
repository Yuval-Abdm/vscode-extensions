// Variables : occurrences dans leur portée (fonction, méthode, closure) ; pour une variable du niveau fichier, dans
// les fichiers de sa chaîne d'inclusion qui l'utilisent (appelants et fichiers inclus), avec `global $x` et
// `$GLOBALS['x']` dans les fonctions — jamais les variables locales homonymes. Une closure qui capture la variable
// (`use ($x)`) et une fonction fléchée (capture implicite) partagent la portée qui les contient.
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

/** Paramètres d'une fonction (noms sans « $ »). */
function parameters(fn: Node): Set<string> {
  const out = new Set<string>();
  for (const p of fn.childForFieldName('parameters')?.namedChildren ?? []) {
    const name = p.childForFieldName('name')?.text;
    if (name) out.add(name.replace(/^\$/, ''));
  }
  return out;
}

/** Portée de `$name` vue depuis `node` : une fonction fléchée lit les variables de la portée qui la contient. */
function nameRoot(node: Node, name: string): Node {
  let root = scopeRoot(node);
  while (root.type === 'arrow_function' && !parameters(root).has(name)) root = scopeRoot(root);
  return root;
}

/** Variables capturées par `use (…)` d'une closure. */
function captures(closure: Node, name: string): boolean {
  const clause = closure.namedChildren.find((c) => c.type === 'anonymous_function_use_clause');
  return !!clause?.descendantsOfType('variable_name').some((v) => v.text === `$${name}`);
}

/** Portées reliées par les closures qui capturent `$name`. */
function linkedRoots(file: SourceFile, root: Node, name: string): Set<number> {
  const roots = new Set([root.id]);
  const closures = file.tree.rootNode.descendantsOfType('anonymous_function').filter((c) => captures(c, name));
  for (let changed = true; changed; ) {
    changed = false;
    for (const closure of closures) {
      const outer = nameRoot(closure, name);
      if (roots.has(closure.id) === roots.has(outer.id)) continue;
      roots.add(closure.id);
      roots.add(outer.id);
      changed = true;
    }
  }
  return roots;
}

export function variableTarget(file: SourceFile, pos: Position): VariableTarget | undefined {
  const node = variableAt(file.tree, pos);
  if (!node) return undefined;
  const name = node.text.slice(1);
  if (ALWAYS_DEFINED.has(name)) return undefined;
  const root = nameRoot(node, name);
  const program = file.tree.rootNode;
  return { name, uri: file.uri, fileLevel: linkedRoots(file, root, name).has(program.id), root };
}

const nameRange = (node: Node): Range => {
  const range = rangeOf(node);
  return { start: { line: range.start.line, character: range.start.character + 1 }, end: range.end };
};

/** `$name` dans les portées `roots`. */
function inScope(file: SourceFile, roots: Set<number>, name: string): Range[] {
  const at = positionsOf(file.text);
  const out: Range[] = [];
  for (const match of file.text.matchAll(new RegExp(`\\$${escape(name)}(?!\\w)`, 'g'))) {
    const node = variableAt(file.tree, at(match.index));
    if (!node || node.startIndex !== match.index || !roots.has(nameRoot(node, name).id)) continue;
    out.push(nameRange(node));
  }
  return out;
}

/** Fonctions du fichier qui importent la variable par `global $name`, et `$GLOBALS['name']`. */
function globals(file: SourceFile, name: string): Range[] {
  const out: Range[] = [];
  for (const declaration of file.tree.rootNode.descendantsOfType('global_declaration')) {
    if (!declaration.namedChildren.some((v) => v.text === `$${name}`)) continue;
    out.push(...inScope(file, linkedRoots(file, scopeRoot(declaration), name), name));
  }
  for (const subscript of file.tree.rootNode.descendantsOfType('subscript_expression')) {
    const [base, key] = subscript.namedChildren;
    if (base?.text !== '$GLOBALS' || !key || (key.type !== 'string' && key.type !== 'encapsed_string') || key.text.slice(1, -1) !== name) continue;
    const range = rangeOf(key);
    out.push({ start: { line: range.start.line, character: range.start.character + 1 }, end: { line: range.end.line, character: range.end.character - 1 } });
  }
  return out;
}

/** Fichiers reliés par inclusion (appelants et inclus) qui utilisent le nom, de proche en proche. */
function chain(env: RefEnv, uri: string, name: string): string[] {
  const graph = env.graph;
  if (!graph) return [uri];
  const key = name.toLowerCase();
  const byUri = new Map(env.files().map((f) => [f.uri, f]));
  const uses = (other: string) => byUri.get(other)?.names?.includes(key) ?? false;
  const seen = new Set([uri]);
  const queue = [uri];
  while (queue.length) {
    const current = queue.shift()!;
    const next = [...graph.includersOf(current).map((s) => s.from), ...graph.sitesOf(current).flatMap((s) => (s.target ? [s.target] : []))];
    for (const other of next) {
      if (seen.has(other) || !uses(other)) continue;
      seen.add(other);
      queue.push(other);
    }
  }
  return [...seen];
}

export function variableReferences(env: RefEnv, file: SourceFile, target: VariableTarget): Location[] {
  if (!target.fileLevel) return inScope(file, linkedRoots(file, target.root, target.name), target.name).map((range) => ({ uri: file.uri, range }));
  const out: Location[] = [];
  for (const uri of chain(env, file.uri, target.name)) {
    const source = uri === file.uri ? { file, release: () => undefined } : env.source(uri);
    if (!source) continue;
    try {
      const program = source.file.tree.rootNode;
      const ranges = [...inScope(source.file, linkedRoots(source.file, program, target.name), target.name), ...globals(source.file, target.name)];
      for (const range of ranges) out.push({ uri, range });
    } finally {
      source.release();
    }
  }
  return out;
}
