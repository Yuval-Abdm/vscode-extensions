// Cache disque de l'index : résumé, taille et date de chaque fichier, en lignes JSON compressées (une ligne d'en-tête
// avec la version, puis une ligne par fichier), lues et écrites en flux : jamais de document de centaines de Mo en
// mémoire (pic de mémoire du serveur à l'ouverture d'un gros projet).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import type { FileSymbols } from '../../shared/types.ts';

/** À incrémenter à chaque changement du format des résumés (FileSymbols), de l'extraction ou du fichier. */
export const CACHE_VERSION = 10;

export interface CacheEntry {
  size: number;
  mtimeMs: number;
  file: FileSymbols;
}

export function cacheFileFor(storageDir: string, folder: string): string {
  return path.join(storageDir, `index-${createHash('sha1').update(folder).digest('hex').slice(0, 16)}.json.gz`);
}

/** Cache d'un dossier ; absent, illisible ou d'une autre version : supprimé et vide. */
export async function loadCache(file: string): Promise<Map<string, CacheEntry>> {
  const entries = new Map<string, CacheEntry>();
  const raw = createReadStream(file);
  const input = raw.pipe(createGunzip());
  try {
    // Erreur de lecture (fichier absent) ou de décompression : `pipe` ne transmet pas les erreurs, écoutées ici
    const failed = new Promise<never>((_, reject) => {
      raw.on('error', reject);
      input.on('error', reject);
    });
    failed.catch(() => undefined);
    let header = true;
    const lines = createInterface({ input, crlfDelay: Infinity });
    const read = (async () => {
      for await (const line of lines) {
        if (header) {
          // Ancien format (un seul document) ou autre version : à reconstruire
          if (!line.startsWith('{"version":') || (JSON.parse(line) as { version?: number }).version !== CACHE_VERSION) throw new Error('version');
          header = false;
        } else if (line) {
          const [key, entry] = JSON.parse(line) as [string, CacheEntry];
          entries.set(key, entry);
        }
      }
    })();
    await Promise.race([read, failed]);
    if (header) throw new Error('empty');
    return entries;
  } catch {
    raw.destroy();
    input.destroy();
    await rm(file, { force: true });
    return new Map();
  }
}

export async function saveCache(file: string, entries: Map<string, CacheEntry>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const gzip = createGzip();
  const done = pipeline(gzip, createWriteStream(tmp));
  const write = async (line: string) => {
    if (!gzip.write(`${line}\n`)) await once(gzip, 'drain');
  };
  await write(JSON.stringify({ version: CACHE_VERSION }));
  for (const entry of entries) await write(JSON.stringify(entry));
  gzip.end();
  await done;
  await rename(tmp, file);
}
