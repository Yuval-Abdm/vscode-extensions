// Cache disque de l'index : résumé, taille et date de chaque fichier, en JSON compressé.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import type { FileSymbols } from '../../shared/types.ts';

/** À incrémenter à chaque changement du format des résumés (FileSymbols) ou de l'extraction. */
export const CACHE_VERSION = 7;

export interface CacheEntry {
  size: number;
  mtimeMs: number;
  file: FileSymbols;
}

interface CacheData {
  version: number;
  entries: [string, CacheEntry][];
}

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export function cacheFileFor(storageDir: string, folder: string): string {
  return path.join(storageDir, `index-${createHash('sha1').update(folder).digest('hex').slice(0, 16)}.json.gz`);
}

/** Cache d'un dossier ; absent, illisible ou d'une autre version : supprimé et vide. */
export async function loadCache(file: string): Promise<Map<string, CacheEntry>> {
  try {
    const data = JSON.parse((await gunzipAsync(await readFile(file))).toString('utf8')) as CacheData;
    if (data.version === CACHE_VERSION && Array.isArray(data.entries)) return new Map(data.entries);
  } catch {
    // absent ou illisible
  }
  await rm(file, { force: true });
  return new Map();
}

export async function saveCache(file: string, entries: Map<string, CacheEntry>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const data: CacheData = { version: CACHE_VERSION, entries: [...entries] };
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, await gzipAsync(JSON.stringify(data)));
  await rename(tmp, file);
}
