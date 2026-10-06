// Pool de worker threads pour l'indexation : lots de fichiers distribués à la demande ;
// les fichiers d'un worker qui tombe (ou ne démarre pas) sont analysés dans le thread courant.
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import type { FileSymbols } from '../../shared/types.ts';
import type { WasmPaths } from '../parser/parser.ts';

export interface PoolOptions {
  workerScript: string;
  wasm: WasmPaths;
  maxFileSize: number;
  workers?: number;
  batchSize?: number;
  onProgress?: (done: number) => void;
  fallback: (filePath: string) => FileSymbols | undefined;
}

export type WorkerMessage = { type: 'ready' } | { type: 'done'; results: (FileSymbols | null)[] };

export function defaultWorkerCount(): number {
  return Math.max(1, Math.min(os.availableParallelism() - 1, 8));
}

export async function indexInWorkers(paths: string[], opts: PoolOptions): Promise<Map<string, FileSymbols | undefined>> {
  const results = new Map<string, FileSymbols | undefined>();
  const size = opts.batchSize ?? 64;
  const batches: string[][] = [];
  for (let i = 0; i < paths.length; i += size) batches.push(paths.slice(i, i + size));
  let next = 0;

  const run = () =>
    new Promise<void>((resolve) => {
      let worker: Worker;
      try {
        worker = new Worker(opts.workerScript, { workerData: { wasm: opts.wasm, maxFileSize: opts.maxFileSize } });
      } catch {
        return resolve();
      }
      let current: string[] | undefined;
      const send = () => {
        current = batches[next++];
        if (current) worker.postMessage(current);
        else void worker.terminate();
      };
      worker.on('message', (message: WorkerMessage) => {
        if (message.type === 'done' && current) {
          message.results.forEach((result, i) => results.set(current![i], result ?? undefined));
          opts.onProgress?.(results.size);
        }
        send();
      });
      worker.on('error', () => {
        // le lot en cours sera repris par le repli
      });
      worker.on('exit', () => resolve());
    });

  const count = Math.min(opts.workers ?? defaultWorkerCount(), batches.length);
  await Promise.all(Array.from({ length: count }, run));
  for (const p of paths) if (!results.has(p)) results.set(p, opts.fallback(p));
  return results;
}
