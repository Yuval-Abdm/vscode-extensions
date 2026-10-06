// Projets PHP de test en mémoire : fichiers sous /p, résumés extraits comme par l'indexeur.
import path from 'node:path';
import { URI } from 'vscode-uri';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { extract } from './helpers.ts';

export const ROOT = '/p';

export const uriOf = (rel: string) => URI.file(path.join(ROOT, rel)).toString();

export async function project(files: Record<string, string>): Promise<SymbolIndex> {
  const index = new SymbolIndex();
  for (const [rel, code] of Object.entries(files)) index.set(await extract(code, uriOf(rel)));
  return index;
}
