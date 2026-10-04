// Serveur LSP PHP Forge : documents ouverts, indexation du workspace (cache + workers), navigation.
// Aucune exception ne doit faire tomber le serveur : chaque gestionnaire est protégé par `safe`.
import path from 'node:path';
import * as l10n from '@vscode/l10n';
import {
  createConnection,
  ProposedFeatures,
  TextDocumentSyncKind,
  type InitializeParams,
  type InitializeResult,
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { DEFAULT_SETTINGS, INDEXED_NOTIFICATION, REINDEX_REQUEST, type IndexedParams, type InitOptions, type Settings } from '../shared/protocol.ts';
import { syntaxDiagnostics } from './diagnostics/syntax.ts';
import { DocumentStore, type OpenDocument } from './documents.ts';
import { definition } from './features/definition.ts';
import { documentSymbols } from './features/documentSymbols.ts';
import { hover } from './features/hover.ts';
import { workspaceSymbols } from './features/workspaceSymbols.ts';
import { cacheFileFor } from './index/cache.ts';
import { indexFileSync } from './index/indexFile.ts';
import { indexFolder } from './index/indexer.ts';
import { Lookup } from './index/lookup.ts';
import { isIndexable } from './index/scan.ts';
import { SymbolIndex } from './index/symbolIndex.ts';
import { applyFileChanges } from './index/updates.ts';
import { createParser, initParser, type Parser, type WasmPaths } from './parser/parser.ts';
import { loadStubs } from './stubs/stubs.ts';

const connection = createConnection(ProposedFeatures.all);
const wasm: WasmPaths = { treeSitter: path.join(__dirname, 'web-tree-sitter.wasm'), php: path.join(__dirname, 'tree-sitter-php.wasm') };
const workspace = new SymbolIndex();
const lookup = new Lookup(workspace, new SymbolIndex());
let parser: Parser;
let documents: DocumentStore;
let settings: Settings = DEFAULT_SETTINGS;
let storagePath: string | undefined;
let folders: string[] = [];
let progressSupported = false;
let indexing: Promise<void> = Promise.resolve();

/** Gestionnaire protégé : une exception est journalisée et le résultat par défaut renvoyé. */
function safe<A extends unknown[], R>(fallback: R, handler: (...args: A) => R | Promise<R>): (...args: A) => Promise<R> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (err) {
      connection.console.error(String((err as Error)?.stack ?? err));
      return fallback;
    }
  };
}

const folderOf = (fsPath: string) => folders.find((folder) => isIndexable(folder, fsPath, settings.exclude));

connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
  const options = (params.initializationOptions ?? {}) as InitOptions;
  if (options.l10nBundle) await l10n.config({ fsPath: options.l10nBundle });
  settings = { ...DEFAULT_SETTINGS, ...options.settings };
  storagePath = options.storagePath;
  progressSupported = params.capabilities.window?.workDoneProgress === true;
  folders = (params.workspaceFolders ?? []).map((f) => URI.parse(f.uri).fsPath);
  if (!folders.length && params.rootUri) folders = [URI.parse(params.rootUri).fsPath];
  await initParser(wasm);
  parser = createParser();
  documents = new DocumentStore(parser);
  lookup.stubs = loadStubs(path.join(__dirname, 'stubs.json.gz'));
  return {
    capabilities: {
      textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental },
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      definitionProvider: true,
      hoverProvider: true,
    },
    serverInfo: { name: 'PHP Forge' },
  };
});

connection.onInitialized(() => {
  if (!lookup.stubs.size) connection.console.warn('PHP stubs not found: native functions are unavailable');
  indexing = reindex();
});

async function reindex(): Promise<void> {
  workspace.clear();
  for (const folder of folders) {
    const progress = progressSupported ? await connection.window.createWorkDoneProgress() : undefined;
    progress?.begin('PHP Forge', 0, l10n.t('Indexing {0}…', path.basename(folder)), false);
    try {
      const stats = await indexFolder(workspace, {
        root: folder,
        exclude: settings.exclude,
        maxFileSize: settings.maxFileSize,
        parser,
        wasm,
        workerScript: path.join(__dirname, 'worker.cjs'),
        cacheFile: storagePath ? cacheFileFor(storagePath, folder) : undefined,
        onProgress: (done, total) => progress?.report(total ? Math.round((done / total) * 100) : 100, `${done}/${total}`),
      });
      connection.console.info(`Indexed ${folder}: ${stats.files} files (${stats.fromCache} from cache, ${stats.parsed} parsed, ${stats.skipped} skipped) in ${stats.ms} ms`);
      void connection.sendNotification(INDEXED_NOTIFICATION, { folder, stats } satisfies IndexedParams);
    } catch (err) {
      connection.console.error(`Indexing ${folder} failed: ${String((err as Error)?.stack ?? err)}`);
    } finally {
      progress?.done();
    }
  }
  // Les documents ouverts priment sur la version enregistrée sur le disque
  for (const doc of documents.all()) workspace.set(doc.symbols);
}

function refresh(doc: OpenDocument): void {
  workspace.set(doc.symbols);
  void connection.sendDiagnostics({ uri: doc.uri, version: doc.doc.version, diagnostics: syntaxDiagnostics(doc.tree) });
}

connection.onDidOpenTextDocument(
  safe(undefined, ({ textDocument: d }) => refresh(documents.open(d.uri, d.languageId, d.version, d.text))),
);

connection.onDidChangeTextDocument(
  safe(undefined, ({ textDocument, contentChanges }) => {
    const doc = documents.change(textDocument.uri, textDocument.version, contentChanges);
    if (doc) refresh(doc);
  }),
);

connection.onDidCloseTextDocument(
  safe(undefined, ({ textDocument }) => {
    documents.close(textDocument.uri);
    void connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
    const uri = URI.parse(textDocument.uri);
    // Retour à la version du disque, si le fichier fait partie du workspace
    const file = uri.scheme === 'file' && folderOf(uri.fsPath) ? indexFileSync(parser, uri.fsPath, settings.maxFileSize) : undefined;
    if (file) workspace.set(file);
    else workspace.delete(textDocument.uri);
  }),
);

connection.onDidChangeWatchedFiles(
  safe(undefined, async ({ changes }) => {
    await indexing;
    await applyFileChanges(workspace, changes, {
      folders,
      exclude: settings.exclude,
      maxFileSize: settings.maxFileSize,
      parser,
      wasm,
      workerScript: path.join(__dirname, 'worker.cjs'),
      isOpen: (uri) => documents.get(uri) !== undefined,
    });
  }),
);

connection.onDocumentSymbol(
  safe([], ({ textDocument }) => {
    const file = documents.get(textDocument.uri)?.symbols ?? workspace.get(textDocument.uri);
    return file ? documentSymbols(file) : [];
  }),
);

connection.onWorkspaceSymbol(safe([], ({ query }) => workspaceSymbols(workspace, query)));

connection.onDefinition(
  safe([], ({ textDocument, position }) => {
    const doc = documents.get(textDocument.uri);
    return doc ? definition(lookup, doc.symbols, doc.tree, position) : [];
  }),
);

connection.onHover(
  safe(null, ({ textDocument, position }) => {
    const doc = documents.get(textDocument.uri);
    return doc ? hover(lookup, doc.symbols, doc.tree, position) : null;
  }),
);

connection.onRequest(
  REINDEX_REQUEST,
  safe(undefined, async () => {
    await indexing;
    indexing = reindex();
    await indexing;
  }),
);

connection.listen();
