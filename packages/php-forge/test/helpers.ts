// Outils de test partagés : analyseur prêt à l'emploi.
import { createRequire } from 'node:module';
import { createParser, initParser, parsePhp, type Parser, type Tree, type WasmPaths } from '../src/server/parser/parser.ts';

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
