// Outils de test partagés : analyseur prêt à l'emploi, extraction depuis du code, curseur « | » dans un extrait.
import { createRequire } from 'node:module';
import { extractFile } from '../src/server/model/extract.ts';
import { createParser, initParser, parsePhp, type Node, type Parser, type Tree, type WasmPaths } from '../src/server/parser/parser.ts';
import type { FileSymbols, Position } from '../src/shared/types.ts';

const require = createRequire(import.meta.url);

export const wasm: WasmPaths = {
  treeSitter: require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
  php: require.resolve('tree-sitter-php/tree-sitter-php.wasm'),
};

export async function parser(): Promise<Parser> {
  await initParser(wasm);
  return createParser();
}

export async function parse(code: string): Promise<Tree> {
  return parsePhp(await parser(), code);
}

export async function extract(code: string, uri = 'file:///test.php'): Promise<FileSymbols> {
  return extractFile(await parse(code), uri);
}

/** Retire le marqueur « | » du code (le dernier : « A|B » peut le précéder) et renvoie sa position. */
export function cursor(code: string): { text: string; position: Position } {
  const offset = code.lastIndexOf('|');
  if (offset < 0) throw new Error('missing | marker');
  const before = code.slice(0, offset).split('\n');
  return {
    text: code.slice(0, offset) + code.slice(offset + 1),
    position: { line: before.length - 1, character: before[before.length - 1].length },
  };
}

/** Expression qui commence à la position (le plus grand nœud d'expression qui y démarre). */
export function expressionAt(tree: Tree, position: Position): Node {
  const STOP = new Set(['expression_statement', 'echo_statement', 'return_statement', 'program', 'compound_statement', 'argument', 'arguments']);
  let node = tree.rootNode.namedDescendantForPosition({ row: position.line, column: position.character })!;
  while (node.parent && node.parent.startIndex === node.startIndex && !STOP.has(node.parent.type)) node = node.parent;
  return node;
}
