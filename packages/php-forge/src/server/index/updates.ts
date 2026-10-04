// Changements de fichiers signalés par l'éditeur (création, modification, suppression, y compris de dossiers) :
// mise à jour de l'index sans bloquer le serveur (worker threads pour les gros lots, pauses sinon).
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { URI } from 'vscode-uri';
import type { FileSymbols } from '../../shared/types.ts';
import type { Parser, WasmPaths } from '../parser/parser.ts';
import { indexFileSync } from './indexFile.ts';
import { indexInWorkers } from './pool.ts';
import { isIndexable, listPhpFiles, PHP_EXTENSIONS } from './scan.ts';
import type { SymbolIndex } from './symbolIndex.ts';

/** Mêmes valeurs que FileChangeType de LSP. */
export const FileChangeKind = { Created: 1, Changed: 2, Deleted: 3 } as const;

export interface FileChange {
  uri: string;
  type: number;
}

export interface UpdateContext {
  folders: string[];
  exclude: string[];
  maxFileSize: number;
  parser: Parser;
  wasm: WasmPaths;
  workerScript: string;
  /** 0 : tout dans le thread courant */
  workers?: number;
  /** Nombre minimal de fichiers à analyser pour lancer des workers (défaut 200) */
  workerThreshold?: number;
  /** Documents ouverts : leur version de l'éditeur prime sur le disque */
  isOpen?: (uri: string) => boolean;
}

export async function applyFileChanges(index: SymbolIndex, changes: FileChange[], ctx: UpdateContext): Promise<{ indexed: number; removed: number }> {
  const isOpen = ctx.isOpen ?? (() => false);
  const toParse = new Set<string>();
  let removed = 0;
  const remove = (uri: string) => {
    if (isOpen(uri) || !index.get(uri)) return;
    index.delete(uri);
    removed++;
  };

  for (const change of changes) {
    if (isOpen(change.uri)) continue;
    const fsPath = URI.parse(change.uri).fsPath;
    const isPhp = PHP_EXTENSIONS.includes(path.extname(fsPath).toLowerCase());
    if (change.type === FileChangeKind.Deleted) {
      remove(change.uri);
      // Dossier supprimé ou renommé : l'éditeur ne signale que le dossier
      if (!isPhp) {
        const prefix = change.uri.endsWith('/') ? change.uri : `${change.uri}/`;
        for (const file of [...index.files()]) if (file.uri.startsWith(prefix)) remove(file.uri);
      }
      continue;
    }
    if (isPhp) {
      if (ctx.folders.some((folder) => isIndexable(folder, fsPath, ctx.exclude))) toParse.add(fsPath);
      else remove(change.uri);
      continue;
    }
    // Dossier créé (ou nouveau nom d'un dossier renommé) : ses fichiers PHP
    if (change.type === FileChangeKind.Created && (await stat(fsPath).catch(() => undefined))?.isDirectory()) {
      for (const file of await listPhpFiles(fsPath)) {
        if (ctx.folders.some((folder) => isIndexable(folder, file, ctx.exclude))) toParse.add(file);
      }
    }
  }

  const paths = [...toParse];
  const parseHere = (p: string) => indexFileSync(ctx.parser, p, ctx.maxFileSize);
  let results: Map<string, FileSymbols | undefined>;
  if (ctx.workers !== 0 && paths.length >= (ctx.workerThreshold ?? 200)) {
    results = await indexInWorkers(paths, { workerScript: ctx.workerScript, wasm: ctx.wasm, maxFileSize: ctx.maxFileSize, workers: ctx.workers, fallback: parseHere });
  } else {
    results = new Map();
    for (const [i, p] of paths.entries()) {
      results.set(p, parseHere(p));
      // Laisse passer les requêtes de l'éditeur entre deux séries de fichiers
      if (i % 20 === 19) await new Promise((resolve) => setImmediate(resolve));
    }
  }

  let indexed = 0;
  for (const p of paths) {
    const uri = URI.file(p).toString();
    if (isOpen(uri)) continue;
    const file = results.get(p);
    if (file) {
      index.set(file);
      indexed++;
    } else {
      remove(uri);
    }
  }
  return { indexed, removed };
}
