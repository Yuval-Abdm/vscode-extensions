// Indexation d'un dossier : résumés en cache réutilisés si le fichier n'a pas changé (taille + date),
// les autres analysés (worker threads au-delà d'un seuil), puis le cache est réécrit.
import { stat } from 'node:fs/promises';
import type { FileSymbols } from '../../shared/types.ts';
import type { Parser, WasmPaths } from '../parser/parser.ts';
import { loadCache, saveCache, type CacheEntry } from './cache.ts';
import { indexFileSync } from './indexFile.ts';
import { indexInWorkers } from './pool.ts';
import { listPhpFiles } from './scan.ts';
import type { SymbolIndex } from './symbolIndex.ts';

export interface IndexerOptions {
  root: string;
  exclude: string[];
  maxFileSize: number;
  parser: Parser;
  wasm: WasmPaths;
  workerScript: string;
  cacheFile?: string;
  /** 0 : tout dans le thread courant ; défaut : cœurs − 1 (8 au plus) */
  workers?: number;
  /** Nombre minimal de fichiers à analyser pour lancer des workers (défaut 200) */
  workerThreshold?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface IndexStats {
  files: number;
  parsed: number;
  fromCache: number;
  skipped: number;
  syntaxErrors: number;
  ms: number;
}

export async function indexFolder(index: SymbolIndex, opts: IndexerOptions): Promise<IndexStats> {
  const started = performance.now();
  // Listage du dossier et lecture du cache en même temps (décompression dans le pool de libuv)
  const [paths, cache] = await Promise.all([listPhpFiles(opts.root, opts.exclude), opts.cacheFile ? loadCache(opts.cacheFile) : new Map<string, CacheEntry>()]);
  const entries = new Map<string, CacheEntry>();
  const stale: { path: string; size: number; mtimeMs: number }[] = [];
  await Promise.all(
    paths.map(async (p) => {
      const s = await stat(p).catch(() => undefined);
      if (!s) return;
      const cached = cache.get(p);
      if (cached && cached.size === s.size && cached.mtimeMs === s.mtimeMs) entries.set(p, cached);
      else stale.push({ path: p, size: s.size, mtimeMs: s.mtimeMs });
    }),
  );

  const fromCache = entries.size;
  const progress = (done: number) => opts.onProgress?.(fromCache + done, paths.length);
  progress(0);
  const fallback = (p: string) => indexFileSync(opts.parser, p, opts.maxFileSize);
  const stalePaths = stale.map((s) => s.path);
  let parsed: Map<string, FileSymbols | undefined>;
  if (opts.workers !== 0 && stale.length >= (opts.workerThreshold ?? 200)) {
    parsed = await indexInWorkers(stalePaths, {
      workerScript: opts.workerScript, wasm: opts.wasm, maxFileSize: opts.maxFileSize, workers: opts.workers, onProgress: progress, fallback,
    });
  } else {
    parsed = new Map();
    for (const p of stalePaths) {
      parsed.set(p, fallback(p));
      if (parsed.size % 50 === 0) progress(parsed.size);
    }
  }

  let skipped = 0;
  for (const s of stale) {
    const file = parsed.get(s.path);
    if (file) entries.set(s.path, { size: s.size, mtimeMs: s.mtimeMs, file });
    else skipped++;
  }
  let syntaxErrors = 0;
  for (const { file } of entries.values()) {
    index.set(file);
    if (file.syntaxError) syntaxErrors++;
  }
  progress(stale.length);
  // Cache réécrit seulement s'il a changé (fichier analysé, ajouté ou supprimé) : JSON de centaines de Mo, ≈ 3 s
  // (les fichiers ignorés — trop gros, binaires — restent « à analyser » à chaque fois sans changer le cache)
  const changed = entries.size - fromCache > 0 || [...cache.keys()].some((key) => !entries.has(key));
  if (opts.cacheFile && changed) await saveCache(opts.cacheFile, entries);
  return { files: paths.length, parsed: stale.length - skipped, fromCache, skipped, syntaxErrors, ms: Math.round(performance.now() - started) };
}
