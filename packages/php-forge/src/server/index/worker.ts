// Worker d'indexation : charge l'analyseur puis traite les lots de fichiers envoyés par le pool.
import { parentPort, workerData } from 'node:worker_threads';
import { createParser, initParser, type WasmPaths } from '../parser/parser.ts';
import { indexFileSync } from './indexFile.ts';
import type { WorkerMessage } from './pool.ts';

interface WorkerInit {
  wasm: WasmPaths;
  maxFileSize: number;
}

async function main(): Promise<void> {
  const { wasm, maxFileSize } = workerData as WorkerInit;
  await initParser(wasm);
  const parser = createParser();
  const port = parentPort!;
  port.on('message', (paths: string[]) => {
    const results = paths.map((p) => {
      try {
        return indexFileSync(parser, p, maxFileSize) ?? null;
      } catch {
        return null;
      }
    });
    port.postMessage({ type: 'done', results } satisfies WorkerMessage);
  });
  port.postMessage({ type: 'ready' } satisfies WorkerMessage);
}

void main();
