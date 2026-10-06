// Cache disque de l'index : résumé, taille et date de chaque fichier, en lignes JSON compressées (une ligne d'en-tête
// avec la version, puis une ligne par fichier), lues et écrites en flux : jamais de document de centaines de Mo en
// mémoire (pic de mémoire du serveur à l'ouverture d'un gros projet).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';
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

/** Longueur d'une ligne d'en-tête ; au-delà : ancien format (un seul document) */
const HEADER_LINE = 64;
/** Longueur d'une ligne (résumé d'un fichier) au-delà de laquelle le cache est jugé corrompu */
const MAX_LINE = 64_000_000;

/**
 * Garde du flux décompressé : en-tête sur une ligne courte, lignes bornées. Un ancien cache (un document de centaines
 * de Mo sur une seule ligne) est rejeté dès ses premiers octets, sans que readline ne l'accumule (chaîne trop longue).
 */
function lineGuard(maxLine: number): Transform {
  let pending = 0;
  let header = true;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      let start = 0;
      for (let nl = chunk.indexOf(10); ; nl = chunk.indexOf(10, start)) {
        // Longueur de la ligne en cours (commencée dans un morceau précédent pour la première)
        const length = pending + (nl < 0 ? chunk.length : nl) - start;
        if (length > (header ? HEADER_LINE : maxLine)) {
          callback(new Error(header ? 'header' : 'line too long'));
          return;
        }
        if (nl < 0) {
          pending = length;
          break;
        }
        header = false;
        pending = 0;
        start = nl + 1;
      }
      callback(null, chunk);
    },
  });
}

/** Cache d'un dossier ; absent, illisible ou d'une autre version : supprimé et vide. */
export async function loadCache(file: string, options: { maxLine?: number } = {}): Promise<Map<string, CacheEntry>> {
  const entries = new Map<string, CacheEntry>();
  const raw = createReadStream(file);
  const gunzip = createGunzip();
  const guard = lineGuard(options.maxLine ?? MAX_LINE);
  const input = raw.pipe(gunzip).pipe(guard);
  try {
    // Erreur de lecture (fichier absent) ou de décompression : `pipe` ne transmet pas les erreurs, écoutées ici
    const failed = new Promise<never>((_, reject) => {
      raw.on('error', reject);
      gunzip.on('error', reject);
      guard.on('error', reject);
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
    gunzip.destroy();
    guard.destroy();
    await rm(file, { force: true });
    return new Map();
  }
}

export async function saveCache(file: string, entries: Map<string, CacheEntry>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const gzip = createGzip();
  const done = pipeline(gzip, createWriteStream(tmp));
  // Échec d'écriture (disque plein, dossier en lecture seule) pendant la boucle : la promesse du flux ne doit
  // jamais rester sans écouteur (rejet non traité = arrêt du serveur)
  done.catch(() => undefined);
  const write = async (line: string) => {
    if (!gzip.write(`${line}\n`)) await Promise.race([once(gzip, 'drain'), done]);
  };
  try {
    await write(JSON.stringify({ version: CACHE_VERSION }));
    for (const entry of entries) await write(JSON.stringify(entry));
    gzip.end();
    await done;
    await rename(tmp, file);
  } catch (err) {
    gzip.destroy();
    await rm(tmp, { force: true, recursive: false }).catch(() => undefined);
    throw err;
  }
}
