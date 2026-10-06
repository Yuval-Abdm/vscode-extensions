// Outils des tests du formateur.
import { tokensOf } from '../src/server/format/tokens.ts';
import { parse } from './helpers.ts';

/** Suite des jetons de l'arbre (type et texte) : un formatage ne doit jamais la changer. */
export async function tokenStream(code: string): Promise<string[]> {
  const tree = await parse(code);
  return tokensOf(tree).map((t) => `${t.type}:${code.slice(t.start, t.end).replace(/\s+/g, ' ')}`);
}
