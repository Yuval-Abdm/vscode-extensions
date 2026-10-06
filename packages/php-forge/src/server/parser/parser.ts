// Analyseur tree-sitter-php (WASM), initialisé une fois par processus (serveur ou worker).
import { Language, Parser, type Tree } from 'web-tree-sitter';

export type { Node, Parser, Tree } from 'web-tree-sitter';
export { Edit } from 'web-tree-sitter';

/** Emplacements des fichiers WASM : moteur tree-sitter et grammaire PHP. */
export interface WasmPaths {
  treeSitter: string;
  php: string;
}

let language: Language | undefined;

export async function initParser(paths: WasmPaths): Promise<void> {
  if (language) return;
  await Parser.init({ locateFile: () => paths.treeSitter });
  language = await Language.load(paths.php);
}

export function getLanguage(): Language {
  if (!language) throw new Error('initParser() must be called first');
  return language;
}

export function createParser(): Parser {
  const parser = new Parser();
  parser.setLanguage(getLanguage());
  return parser;
}

/** Analyse complète, ou incrémentale si l'ancien arbre (déjà modifié par `edit`) est fourni. */
export function parsePhp(parser: Parser, text: string, old?: Tree): Tree {
  const tree = parser.parse(text, old);
  if (!tree) throw new Error('tree-sitter parse failed');
  return tree;
}
