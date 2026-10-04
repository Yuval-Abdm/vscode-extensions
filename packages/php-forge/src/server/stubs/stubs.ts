// Fonctions, classes et constantes natives de PHP : index généré au build depuis JetBrains/phpstorm-stubs.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { FileSymbols } from '../../shared/types.ts';
import { SymbolIndex } from '../index/symbolIndex.ts';

export const STUBS_TAG = 'v2026.2';
/** À incrémenter si le format du fichier généré change */
export const STUBS_FORMAT = 1;

interface StubsFile {
  format: number;
  tag: string;
  files: FileSymbols[];
}

/** Index des stubs ; vide si le fichier est absent, illisible ou d'un autre format. */
export function loadStubs(file: string): SymbolIndex {
  const index = new SymbolIndex();
  try {
    const data = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as StubsFile;
    if (data.format !== STUBS_FORMAT) return index;
    for (const stub of data.files) index.set(stub);
  } catch {
    // absent ou illisible
  }
  return index;
}

/** Extension PHP d'un stub : « phpstub:/mysqli/mysqli.php » → « mysqli ». */
export function stubExtension(uri: string): string {
  return uri.replace(/^phpstub:\/+/, '').split('/')[0];
}
