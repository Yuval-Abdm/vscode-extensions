// Serveur LSP PHP Forge : documents ouverts, indexation du workspace (cache + workers), navigation,
// complétion, aide aux paramètres, indications inline, tokens sémantiques.
// Aucune exception ne doit faire tomber le serveur : chaque gestionnaire est protégé par `safe`.
import path from 'node:path';
import * as l10n from '@vscode/l10n';
import { CodeActionKind, createConnection, ProposedFeatures, TextDocumentSyncKind, type CompletionItem, type InitializeParams, type InitializeResult } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import {
  INDEXED_NOTIFICATION, mergeSettings, REINDEX_REQUEST, STATUS_NOTIFICATION,
  type IndexedParams, type InitOptions, type Settings, type StatusParams,
} from '../shared/protocol.ts';
import { complete, resolveCompletion } from './completion/complete.ts';
import { syntaxDiagnostics } from './diagnostics/syntax.ts';
import { tagDiagnostics } from './diagnostics/tags.ts';
import { sqlQuoteDiagnostics } from './sql/quotes.ts';
import { DocumentStore, type OpenDocument } from './documents.ts';
import { quickFixes } from './features/codeActions.ts';
import { definition } from './features/definition.ts';
import { documentSymbols } from './features/documentSymbols.ts';
import { foldingRanges } from './features/folding.ts';
import { highlights } from './features/highlight.ts';
import { hover } from './features/hover.ts';
import { implementations } from './features/implementation.ts';
import { inlayHints } from './features/inlayHints.ts';
import { selectionRanges } from './features/selection.ts';
import { semanticTokens, TOKEN_MODIFIERS, TOKEN_TYPES } from './features/semanticTokens.ts';
import { signatureHelp } from './features/signatureHelp.ts';
import { workspaceSymbols } from './features/workspaceSymbols.ts';
import { cacheFileFor } from './index/cache.ts';
import { indexFileSync } from './index/indexFile.ts';
import { indexFolder } from './index/indexer.ts';
import { Lookup } from './index/lookup.ts';
import { isIndexable } from './index/scan.ts';
import { SymbolIndex } from './index/symbolIndex.ts';
import { applyFileChanges } from './index/updates.ts';
import { createParser, initParser, type Parser, type WasmPaths } from './parser/parser.ts';
import { detectPhpVersion } from './settings/phpVersion.ts';
import { loadStubs } from './stubs/stubs.ts';
import { TypeResolver } from './types/expand.ts';

const connection = createConnection(ProposedFeatures.all);
const wasm: WasmPaths = { treeSitter: path.join(__dirname, 'web-tree-sitter.wasm'), php: path.join(__dirname, 'tree-sitter-php.wasm') };
const workspace = new SymbolIndex();
const lookup = new Lookup(workspace, new SymbolIndex());
const resolver = new TypeResolver(lookup);
let parser: Parser;
let documents: DocumentStore;
let settings: Settings = mergeSettings(undefined);
let status: StatusParams = { phpVersion: '', source: 'default' };
let storagePath: string | undefined;
let folders: string[] = [];
let progressSupported = false;
let indexing: Promise<void> = Promise.resolve();
/** Types déduits des documents modifiés, calculés après une pause de frappe */
const inference = new Map<string, ReturnType<typeof setTimeout>>();
const INFERENCE_DELAY = 300;

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
const docAt = (uri: string): OpenDocument | undefined => documents.get(uri);

/** Version de PHP et fonctions natives selon les réglages. */
async function applyEnvironment(): Promise<void> {
  const detected = await detectPhpVersion(folders, settings.phpVersion);
  resolver.phpVersion = detected.version;
  lookup.stubs = loadStubs(path.join(__dirname, 'stubs.json.gz'), settings.stubs);
  status = { phpVersion: detected.version, source: detected.source };
}

connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
  const options = (params.initializationOptions ?? {}) as InitOptions;
  if (options.l10nBundle) await l10n.config({ fsPath: options.l10nBundle });
  settings = mergeSettings(options.settings);
  storagePath = options.storagePath;
  progressSupported = params.capabilities.window?.workDoneProgress === true;
  folders = (params.workspaceFolders ?? []).map((f) => URI.parse(f.uri).fsPath);
  if (!folders.length && params.rootUri) folders = [URI.parse(params.rootUri).fsPath];
  await initParser(wasm);
  parser = createParser();
  documents = new DocumentStore(parser);
  await applyEnvironment();
  return {
    capabilities: {
      textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental },
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      definitionProvider: true,
      hoverProvider: true,
      completionProvider: { triggerCharacters: ['$', '>', ':', '\\', '/', "'", '"', '@'], resolveProvider: true },
      signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [','] },
      implementationProvider: true,
      documentHighlightProvider: true,
      foldingRangeProvider: true,
      selectionRangeProvider: true,
      inlayHintProvider: true,
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
      semanticTokensProvider: { legend: { tokenTypes: [...TOKEN_TYPES], tokenModifiers: [...TOKEN_MODIFIERS] }, full: true },
    },
    serverInfo: { name: 'PHP Forge' },
  };
});

connection.onInitialized(() => {
  if (!lookup.stubs.size) connection.console.warn('PHP stubs not found: native functions are unavailable');
  void connection.sendNotification(STATUS_NOTIFICATION, status);
  indexing = reindex();
});

connection.onDidChangeConfiguration(
  safe(undefined, async ({ settings: all }) => {
    const next = mergeSettings((all as { phpForge?: Partial<Settings> } | undefined)?.phpForge);
    const environment = next.phpVersion !== settings.phpVersion || next.stubs.join() !== settings.stubs.join();
    // exclude et maxFileSize : le client redémarre le serveur
    settings = { ...next, exclude: settings.exclude, maxFileSize: settings.maxFileSize };
    if (environment) {
      await applyEnvironment();
      void connection.sendNotification(STATUS_NOTIFICATION, status);
      connection.languages.semanticTokens.refresh();
    }
    void connection.languages.inlayHint.refresh();
  }),
);

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

function diagnosticsOf(doc: OpenDocument) {
  const text = doc.doc.getText();
  return [...syntaxDiagnostics(doc.tree, 100, { parser, text }), ...tagDiagnostics(doc.tree, text), ...sqlQuoteDiagnostics(doc.tree)];
}

function refresh(doc: OpenDocument): void {
  workspace.set(doc.symbols);
  void connection.sendDiagnostics({ uri: doc.uri, version: doc.doc.version, diagnostics: diagnosticsOf(doc) });
}

connection.onDidOpenTextDocument(
  safe(undefined, ({ textDocument: d }) => refresh(documents.open(d.uri, d.languageId, d.version, d.text))),
);

connection.onDidChangeTextDocument(
  safe(undefined, ({ textDocument, contentChanges }) => {
    const doc = documents.change(textDocument.uri, textDocument.version, contentChanges);
    if (!doc) return;
    refresh(doc);
    clearTimeout(inference.get(doc.uri));
    inference.set(
      doc.uri,
      setTimeout(() => {
        inference.delete(doc.uri);
        try {
          const inferred = documents.inferTypes(doc.uri);
          if (inferred) workspace.set(inferred.symbols);
        } catch (err) {
          connection.console.error(String((err as Error)?.stack ?? err));
        }
      }, INFERENCE_DELAY),
    );
  }),
);

connection.onDidCloseTextDocument(
  safe(undefined, ({ textDocument }) => {
    clearTimeout(inference.get(textDocument.uri));
    inference.delete(textDocument.uri);
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
    const file = docAt(textDocument.uri)?.symbols ?? workspace.get(textDocument.uri);
    return file ? documentSymbols(file) : [];
  }),
);

connection.onWorkspaceSymbol(safe([], ({ query }) => workspaceSymbols(workspace, query)));

connection.onDefinition(
  safe([], ({ textDocument, position }) => {
    const doc = docAt(textDocument.uri);
    return doc ? definition(lookup, doc.symbols, doc.tree, position, resolver) : [];
  }),
);

connection.onHover(
  safe(null, ({ textDocument, position }) => {
    const doc = docAt(textDocument.uri);
    return doc ? hover(lookup, doc.symbols, doc.tree, position, resolver) : null;
  }),
);

connection.onCompletion(
  safe(null, ({ textDocument, position }) => {
    const doc = docAt(textDocument.uri);
    return doc ? complete({ resolver, parser, folders }, doc, position) : null;
  }),
);

connection.onCompletionResolve((item: CompletionItem) => {
  try {
    return resolveCompletion(resolver, item);
  } catch (err) {
    connection.console.error(String((err as Error)?.stack ?? err));
    return item;
  }
});

connection.onSignatureHelp(
  safe(null, ({ textDocument, position }) => {
    const doc = docAt(textDocument.uri);
    return doc ? signatureHelp({ resolver, parser }, doc, position) : null;
  }),
);

connection.onImplementation(
  safe([], ({ textDocument, position }) => {
    const doc = docAt(textDocument.uri);
    return doc ? implementations(lookup, doc.symbols, doc.tree, position, resolver) : [];
  }),
);

connection.onDocumentHighlight(
  safe([], ({ textDocument, position }) => {
    const doc = docAt(textDocument.uri);
    return doc ? highlights(doc.tree, doc.doc.getText(), position) : [];
  }),
);

connection.onCodeAction(safe([], ({ textDocument, context }) => quickFixes(textDocument.uri, context.diagnostics)));

connection.onFoldingRanges(
  safe([], ({ textDocument }) => {
    const doc = docAt(textDocument.uri);
    return doc ? foldingRanges(doc.tree) : [];
  }),
);

connection.onSelectionRanges(
  safe([], ({ textDocument, positions }) => {
    const doc = docAt(textDocument.uri);
    return doc ? selectionRanges(doc.tree, positions) : [];
  }),
);

connection.languages.inlayHint.on(
  safe([], ({ textDocument, range }) => {
    const doc = docAt(textDocument.uri);
    return doc ? inlayHints(resolver, doc.symbols, doc.tree, range, settings.inlayHints) : [];
  }),
);

connection.languages.semanticTokens.on(
  safe({ data: [] as number[] }, ({ textDocument }) => {
    const doc = docAt(textDocument.uri);
    return { data: doc ? semanticTokens(lookup, doc.symbols, doc.tree) : [] };
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
