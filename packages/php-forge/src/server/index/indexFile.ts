// Analyse d'un fichier du disque → résumé ; undefined si illisible, trop gros ou binaire.
import { readFileSync, statSync } from 'node:fs';
import { URI } from 'vscode-uri';
import type { FileSymbols } from '../../shared/types.ts';
import { extractFile } from '../model/extract.ts';
import { decode } from '../parser/encoding.ts';
import { parsePhp, type Parser } from '../parser/parser.ts';

export function indexFileSync(parser: Parser, filePath: string, maxFileSize: number): FileSymbols | undefined {
  let bytes: Buffer;
  try {
    if (statSync(filePath).size > maxFileSize) return undefined;
    bytes = readFileSync(filePath);
  } catch {
    return undefined;
  }
  if (bytes.includes(0)) return undefined;
  const tree = parsePhp(parser, decode(bytes));
  try {
    return extractFile(tree, URI.file(filePath).toString());
  } finally {
    tree.delete();
  }
}
