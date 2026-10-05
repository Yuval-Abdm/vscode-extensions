// Serveur LSP PHP Forge : documents ouverts, indexation du workspace (cache + workers), navigation,
// complétion, aide aux paramètres, indications inline, tokens sémantiques.
// Aucune exception ne doit faire tomber le serveur : chaque gestionnaire est protégé par `safe`.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import * as l10n from '@vscode/l10n';
import { CodeActionKind, createConnection, type CodeAction, ErrorCodes, ResponseError, ProposedFeatures, TextDocumentSyncKind, type CompletionItem, type Diagnostic, type InitializeParams, type InitializeResult } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import {
  BASELINE_REQUEST, BASELINE_STATUS_NOTIFICATION, INCLUDE_TREE_REQUEST, INCLUDERS_REQUEST, INDEXED_NOTIFICATION, mergeSettings, REINDEX_REQUEST, STATUS_NOTIFICATION,
  type BaselineParams, type BaselineResult, type IncludeTree, type IndexedParams, type InitOptions, type Settings, type StatusParams,
} from '../shared/protocol.ts';
import { complete, resolveCompletion } from './completion/complete.ts';
import { Baseline } from './diagnostics/baseline.ts';
import { collectDiagnostics, semanticPart, type CollectEnv, type CollectInput } from './diagnostics/collect.ts';
import { findComposerDirs, isLibrary } from './diagnostics/policy.ts';
import { WorkspaceDiagnostics } from './diagnostics/workspace.ts';
import { decode } from './parser/encoding.ts';
import { shiftDiagnostics } from './diagnostics/shift.ts';
import { DocumentStore, type OpenDocument } from './documents.ts';
import { IncludeAnalysis } from './includes/analysis.ts';
import { callerLabel, includeDiagnostics, relativePath } from './includes/diagnostics.ts';
import { IncludeGraph } from './includes/graph.ts';
import { includeDefinition, includeLinks, includerLinks, includersLens } from './includes/navigation.ts';
import { quickFixes } from './features/codeActions.ts';
import { findReferences, targetAt, type RefEnv, type SourceFile } from './refactor/references.ts';
import { variableReferences, variableTarget } from './refactor/variables.ts';
import { prepareRename, renameAt } from './refactor/rename.ts';
import { resolveLens, symbolLenses } from './refactor/codeLens.ts';
import { organizeUses } from './imports/uses.ts';
import { importAllMissing, importFixes } from './imports/fixes.ts';
import { problemsMarkdown, withProblems } from './features/problemHover.ts';
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
import { createParser, initParser, parsePhp, type Parser, type WasmPaths } from './parser/parser.ts';
import { detectPhpVersion } from './settings/phpVersion.ts';
import { loadStubs } from './stubs/stubs.ts';
import { TypeResolver } from './types/expand.ts';
import { registerExternal } from './types/external.ts';

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
/** Analyse des inclusions, relancée après l'indexation et les modifications */
let analysis: IncludeAnalysis | undefined;
/** Analyse des inclusions à refaire (modification en attente, ou pas encore faite) */
let analysisPending = true;
let analysisTimer: ReturnType<typeof setTimeout> | undefined;
const ANALYSIS_DELAY = 500;
/** Incrémentée à chaque modification : une analyse en cours devenue obsolète s'interrompt */
let analysisGeneration = 0;
/** Règles sémantiques des documents ouverts, recalculées après une pause de frappe */
const semanticCache = new Map<string, Diagnostic[]>();
/** Alertes masquées par la baseline, par fichier */
const hiddenByUri = new Map<string, number>();
const baselines = new Map<string, Baseline>();
let composerDirs: string[] = [];
const workspaceDiagnostics = new WorkspaceDiagnostics();
let statusTimer: ReturnType<typeof setTimeout> | undefined;

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
      textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental, willSaveWaitUntil: true },
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      definitionProvider: true,
      hoverProvider: true,
      completionProvider: { triggerCharacters: ['$', '>', ':', '\\', '/', "'", '"', '@'], resolveProvider: true },
      signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [','] },
      implementationProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      documentHighlightProvider: true,
      foldingRangeProvider: true,
      selectionRangeProvider: true,
      inlayHintProvider: true,
      codeLensProvider: { resolveProvider: true },
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.Source, CodeActionKind.SourceOrganizeImports] },
      semanticTokensProvider: { legend: { tokenTypes: [...TOKEN_TYPES], tokenModifiers: [...TOKEN_MODIFIERS] }, full: true },
    },
    serverInfo: { name: 'PHP Forge' },
  };
});

connection.onInitialized(() => {
  if (!lookup.stubs.size) connection.console.warn('PHP stubs not found: native functions are unavailable');
  void connection.sendNotification(STATUS_NOTIFICATION, status);
  indexing = reindex();
  scheduleAnalysis(0);
  loadBaselines();
  void Promise.all(folders.map(findComposerDirs)).then((dirs) => {
    composerDirs = dirs.flat();
  });
});

connection.onDidChangeConfiguration(
  safe(undefined, async ({ settings: all }) => {
    const previous = settings;
    const next = mergeSettings((all as { phpForge?: Partial<Settings> } | undefined)?.phpForge);
    const environment = next.phpVersion !== settings.phpVersion || next.stubs.join() !== settings.stubs.join();
    // exclude et maxFileSize : le client redémarre le serveur
    settings = { ...next, exclude: settings.exclude, maxFileSize: settings.maxFileSize };
    if (environment) {
      await applyEnvironment();
      void connection.sendNotification(STATUS_NOTIFICATION, status);
      connection.languages.semanticTokens.refresh();
    }
    if (next.documentRoot !== previous.documentRoot || next.serverRoot !== previous.serverRoot || next.includes.maxContexts !== previous.includes.maxContexts || next.externalGlobals.join() !== previous.externalGlobals.join()) {
      scheduleAnalysis(0);
    }
    if (JSON.stringify(next.diagnostics) !== JSON.stringify(previous.diagnostics) || next.libraryPaths.join() !== previous.libraryPaths.join()) {
      for (const doc of documents.all()) publish(doc);
      startWorkspaceDiagnostics();
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

/**
 * Diagnostics d'inclusion des documents ouverts : calculés à chaque analyse, puis déplacés au fil des
 * modifications jusqu'à la suivante (sinon ils resteraient à leur ancienne position pendant la frappe).
 */
const includeCache = new Map<string, Diagnostic[]>();

function includeDiagnosticsOf(doc: OpenDocument): Diagnostic[] {
  const report = analysis?.report(doc.uri);
  if (!analysis || !report) return [];
  const graph = analysis.graph;
  return includeDiagnostics(report, doc.symbols, (via) => callerLabel(graph, via));
}

const rootOf = (fsPath: string) => folders.find((folder) => fsPath.startsWith(folder + path.sep));

function collectEnv(): CollectEnv {
  return {
    parser,
    resolver,
    analysis,
    rules: settings.diagnostics.rules,
    library: (fsPath) => isLibrary(fsPath, folders, settings.libraryPaths, composerDirs),
    baseline: (fsPath) => {
      const root = rootOf(fsPath);
      const baseline = root ? baselines.get(root) : undefined;
      return root && baseline ? { baseline, rel: path.relative(root, fsPath).split(path.sep).join('/') } : undefined;
    },
    includes: (input) => {
      const doc = documents.get(input.uri);
      if (!doc) return undefined;
      if (!includeCache.has(doc.uri)) includeCache.set(doc.uri, includeDiagnosticsOf(doc));
      return includeCache.get(doc.uri);
    },
  };
}

/** Fichier pour une recherche : document ouvert, ou fichier du disque analysé puis libéré. */
function sourceOf(uri: string): { file: SourceFile; release(): void } | undefined {
  const doc = documents.get(uri);
  if (doc) return { file: { uri, text: doc.doc.getText(), tree: doc.tree, symbols: doc.symbols }, release: () => undefined };
  const symbols = workspace.get(uri);
  if (!symbols) return undefined;
  const fsPath = URI.parse(uri).fsPath;
  let bytes: Buffer;
  try {
    if (statSync(fsPath).size > settings.maxFileSize) return undefined;
    bytes = readFileSync(fsPath);
  } catch {
    return undefined;
  }
  const text = decode(bytes);
  const tree = parsePhp(parser, text);
  return { file: { uri, text, tree, symbols }, release: () => tree.delete() };
}

function refEnv(): RefEnv {
  return { lookup, resolver, files: () => [...workspace.files()], source: sourceOf, graph: analysis?.graph };
}

function inputOf(doc: OpenDocument): CollectInput {
  return { uri: doc.uri, fsPath: URI.parse(doc.uri).fsPath, symbols: doc.symbols, tree: doc.tree, text: doc.doc.getText() };
}

function setHidden(uri: string, hidden: number): void {
  if (hidden) hiddenByUri.set(uri, hidden);
  else hiddenByUri.delete(uri);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    let total = 0;
    for (const n of hiddenByUri.values()) total += n;
    void connection.sendNotification(BASELINE_STATUS_NOTIFICATION, { hidden: total, active: baselines.size > 0 });
  }, 200);
}

/** Derniers diagnostics publiés par fichier (survol des problèmes de la ligne). */
const published = new Map<string, Diagnostic[]>();

function publish(doc: OpenDocument): void {
  const result = collectDiagnostics(inputOf(doc), collectEnv(), semanticCache.get(doc.uri) ?? []);
  setHidden(doc.uri, result.hidden);
  published.set(doc.uri, result.diagnostics);
  void connection.sendDiagnostics({ uri: doc.uri, version: doc.doc.version, diagnostics: result.diagnostics });
}

/** Règles sémantiques d'un document ouvert (après une pause de frappe, à l'ouverture). */
function updateSemantic(doc: OpenDocument): void {
  semanticCache.set(doc.uri, semanticPart(inputOf(doc), collectEnv()));
}

/** Au-delà, la passe d'arrière-plan saute les règles sémantiques (secondes de calcul) : vues à l'ouverture. */
const BACKGROUND_SEMANTIC_MAX = 200_000;

/** Diagnostics d'un fichier du disque (passe du workspace, baseline) ; undefined : ignoré. */
function diskDiagnostics(uri: string, background = false): { raw: Diagnostic[]; diagnostics: Diagnostic[]; text: string } | undefined {
  const symbols = workspace.get(uri);
  if (!symbols?.flow) return undefined;
  const fsPath = URI.parse(uri).fsPath;
  const env = collectEnv();
  if (env.library(fsPath)) return undefined;
  let bytes: Buffer;
  try {
    if (statSync(fsPath).size > settings.maxFileSize) return undefined;
    bytes = readFileSync(fsPath);
  } catch {
    return undefined;
  }
  const text = decode(bytes);
  const tree = parsePhp(parser, text);
  try {
    const input: CollectInput = { uri, fsPath, symbols, tree, text };
    const semantic = background && text.length > BACKGROUND_SEMANTIC_MAX ? [] : semanticPart(input, env);
    const result = collectDiagnostics(input, env, semantic);
    setHidden(uri, result.hidden);
    return { raw: result.raw, diagnostics: result.diagnostics, text };
  } finally {
    tree.delete();
  }
}

function publishUri(uri: string, diagnostics: Diagnostic[]): void {
  if (diagnostics.length) published.set(uri, diagnostics);
  else published.delete(uri);
  void connection.sendDiagnostics({ uri, diagnostics });
}

/** Passe du workspace (phpForge.diagnostics.scope = workspace), relancée après chaque analyse des inclusions. */
function startWorkspaceDiagnostics(): void {
  if (settings.diagnostics.scope !== 'workspace') {
    workspaceDiagnostics.clear(publishUri);
    return;
  }
  void workspaceDiagnostics.run({
    files: () => [...workspace.files()].map((f) => f.uri).filter((uri) => uri.startsWith('file:')),
    skip: (uri) => documents.get(uri) !== undefined,
    compute: (uri) => diskDiagnostics(uri, true)?.diagnostics,
    publish: publishUri,
    error: (uri, err) => connection.console.error(`${uri}: ${String((err as Error)?.stack ?? err)}`),
  }).catch((err) => connection.console.error(String((err as Error)?.stack ?? err)));
}

function loadBaselines(): void {
  baselines.clear();
  for (const folder of folders) {
    const baseline = Baseline.load(folder);
    if (baseline) baselines.set(folder, baseline);
  }
}

/** Variables venues des fichiers inclus et des appelants pour un document ouvert (après chaque extraction). */
function track(doc: OpenDocument): void {
  registerExternal(doc.symbols.scopes, {
    variable: (name, at) => {
      const info = analysis?.variable(doc.uri, name, at);
      if (!analysis || !info) return undefined;
      const origin = info.origin && { ...info.origin, label: `${relativePath(analysis.graph, info.origin.uri)}:${info.origin.line + 1}` };
      return { type: info.type, origin, request: info.request };
    },
    names: (at) => analysis?.names(doc.uri, at) ?? [],
  });
}

function refresh(doc: OpenDocument): void {
  track(doc);
  workspace.set(doc.symbols);
  publish(doc);
}

/** Relance l'analyse des inclusions après un délai (modifications groupées), jamais pendant l'indexation. */
function scheduleAnalysis(delay = ANALYSIS_DELAY): void {
  clearTimeout(analysisTimer);
  analysisGeneration++;
  analysisPending = true;
  analysisTimer = setTimeout(() => {
    void indexing.then(safe(undefined, () => runAnalysis()));
  }, delay);
}

/** Analyse coopérative : rend la main entre les scripts d'entrée, abandonnée si une modification arrive entre-temps. */
async function runAnalysis(workspacePass = true): Promise<void> {
  const generation = analysisGeneration;
  const started = Date.now();
  const graph = new IncludeGraph(workspace, { roots: folders, documentRoot: settings.documentRoot, serverRoot: settings.serverRoot });
  const next = new IncludeAnalysis(workspace, lookup, graph, { maxContexts: settings.includes.maxContexts, externalGlobals: settings.externalGlobals });
  if (!(await next.runAsync(() => generation !== analysisGeneration))) return;
  analysis = next;
  analysisPending = false;
  includeCache.clear();
  connection.console.info(`Include analysis: ${graph.size} files in ${Date.now() - started} ms`);
  for (const doc of documents.all()) publish(doc);
  if (workspacePass) startWorkspaceDiagnostics();
  void connection.sendRequest('workspace/codeLens/refresh').catch(() => undefined);
}

connection.onDidOpenTextDocument(
  safe(undefined, ({ textDocument: d }) => {
    const doc = documents.open(d.uri, d.languageId, d.version, d.text);
    workspaceDiagnostics.forget(d.uri);
    updateSemantic(doc);
    refresh(doc);
  }),
);

connection.onDidChangeTextDocument(
  safe(undefined, ({ textDocument, contentChanges }) => {
    const doc = documents.change(textDocument.uri, textDocument.version, contentChanges);
    if (!doc) return;
    // La passe du workspace rend la main à la frappe ; relancée après la prochaine analyse
    workspaceDiagnostics.cancel();
    const cached = includeCache.get(doc.uri);
    if (cached) includeCache.set(doc.uri, shiftDiagnostics(cached, contentChanges));
    const semantic = semanticCache.get(doc.uri);
    if (semantic) semanticCache.set(doc.uri, shiftDiagnostics(semantic, contentChanges));
    refresh(doc);
    scheduleAnalysis();
    clearTimeout(inference.get(doc.uri));
    inference.set(
      doc.uri,
      setTimeout(() => {
        inference.delete(doc.uri);
        try {
          const inferred = documents.inferTypes(doc.uri);
          if (inferred) {
            workspace.set(inferred.symbols);
            track(inferred);
          }
          const current = documents.get(doc.uri);
          if (current) {
            updateSemantic(current);
            publish(current);
          }
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
    includeCache.delete(textDocument.uri);
    semanticCache.delete(textDocument.uri);
    setHidden(textDocument.uri, 0);
    published.delete(textDocument.uri);
    const uri = URI.parse(textDocument.uri);
    // Retour à la version du disque, si le fichier fait partie du workspace
    const file = uri.scheme === 'file' && folderOf(uri.fsPath) ? indexFileSync(parser, uri.fsPath, settings.maxFileSize) : undefined;
    if (file) workspace.set(file);
    else workspace.delete(textDocument.uri);
    // Workspace : le fichier fermé garde ses problèmes (version du disque) ; sinon ils disparaissent
    const disk = settings.diagnostics.scope === 'workspace' ? diskDiagnostics(textDocument.uri)?.diagnostics : undefined;
    publishUri(textDocument.uri, disk ?? []);
    workspaceDiagnostics.record(textDocument.uri, !!disk?.length);
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
    scheduleAnalysis();
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
    if (!doc) return [];
    const target = analysis ? includeDefinition(analysis.graph, doc.symbols, position) : [];
    return target.length ? target : definition(lookup, doc.symbols, doc.tree, position, resolver);
  }),
);

connection.onHover(
  safe(null, ({ textDocument, position }) => {
    const doc = docAt(textDocument.uri);
    if (!doc) return null;
    return withProblems(hover(lookup, doc.symbols, doc.tree, position, resolver), problemsMarkdown(doc.uri, doc.doc.version, published.get(doc.uri) ?? [], position.line));
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

/** Sorte d'action demandée (`context.only` absent : toutes). */
const wanted = (only: string[] | undefined, kind: string) => !only || only.some((k) => kind === k || kind.startsWith(`${k}.`));

connection.onCodeAction(
  safe([], ({ textDocument, context }) => {
    const uri = textDocument.uri;
    const doc = docAt(uri);
    const actions: CodeAction[] = quickFixes(uri, context.diagnostics, doc?.doc.getText());
    if (!doc) return actions;
    const text = doc.doc.getText();
    const input = { uri, fsPath: URI.parse(uri).fsPath, text, tree: doc.tree, symbols: doc.symbols };
    const fixEnv = { lookup, graph: analysis?.graph };
    if (wanted(context.only, CodeActionKind.QuickFix)) actions.push(...importFixes(input, context.diagnostics, fixEnv));
    if (wanted(context.only, 'source.addMissingImports')) {
      const all = importAllMissing(input, published.get(uri) ?? [], fixEnv);
      if (all) actions.push(all);
    }
    if (wanted(context.only, CodeActionKind.SourceOrganizeImports)) {
      const edits = organizeUses(doc.tree, text);
      if (edits.length) actions.push({ title: l10n.t('Organize use statements'), kind: CodeActionKind.SourceOrganizeImports, edit: { changes: { [uri]: edits } } });
    }
    return actions;
  }),
);

connection.onWillSaveTextDocumentWaitUntil(
  safe([], ({ textDocument }) => {
    const doc = docAt(textDocument.uri);
    return doc && settings.organizeUsesOnSave ? organizeUses(doc.tree, doc.doc.getText()) : [];
  }),
);

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
    scheduleAnalysis(0);
  }),
);

connection.onCodeLens(
  safe([], ({ textDocument }) => {
    const symbols = docAt(textDocument.uri)?.symbols ?? workspace.get(textDocument.uri);
    return [...(analysis ? includersLens(analysis.graph, textDocument.uri) : []), ...(symbols ? symbolLenses(symbols, settings.codeLens) : [])];
  }),
);

connection.onCodeLensResolve((lens) => {
  try {
    const data = lens.data as { uri?: string } | undefined;
    if (lens.command || !data?.uri) return lens;
    const source = sourceOf(data.uri);
    if (!source) return lens;
    try {
      return resolveLens(refEnv(), lens, source.file, (position) => implementations(lookup, source.file.symbols, source.file.tree, position, resolver));
    } finally {
      source.release();
    }
  } catch (err) {
    connection.console.error(String((err as Error)?.stack ?? err));
    return lens;
  }
});

connection.onRequest(INCLUDERS_REQUEST, safe([], ({ uri }: { uri: string }) => (analysis ? includerLinks(analysis.graph, uri) : [])));

connection.onRequest(
  INCLUDE_TREE_REQUEST,
  safe({ includedBy: [], includes: [] } as IncludeTree, ({ uri }: { uri: string }): IncludeTree => ({
    includedBy: analysis ? includerLinks(analysis.graph, uri) : [],
    includes: analysis ? includeLinks(analysis.graph, uri) : [],
  })),
);

connection.onRequest(
  BASELINE_REQUEST,
  safe({ files: 0, entries: 0 } as BaselineResult, async ({ action }: BaselineParams): Promise<BaselineResult> => {
    await indexing;
    // Les alertes des inclusions font partie de la baseline : analyse à jour d'abord
    if (action !== 'clear' && analysisPending) {
      clearTimeout(analysisTimer);
      analysisGeneration++;
      await runAnalysis(false);
    }
    workspaceDiagnostics.cancel();
    if (action === 'clear') {
      for (const folder of folders) Baseline.clear(folder);
      baselines.clear();
      for (const doc of documents.all()) publish(doc);
      startWorkspaceDiagnostics();
    } else {
      baselines.clear();
      const byRoot = new Map<string, { rel: string; diagnostics: Diagnostic[]; text: string }[]>();
      const add = (fsPath: string, diagnostics: Diagnostic[], text: string) => {
        const root = rootOf(fsPath);
        if (!root || !diagnostics.length) return;
        const list = byRoot.get(root) ?? [];
        list.push({ rel: path.relative(root, fsPath).split(path.sep).join('/'), diagnostics, text });
        byRoot.set(root, list);
      };
      for (const file of workspace.files()) {
        if (!file.uri.startsWith('file:')) continue;
        const doc = documents.get(file.uri);
        if (doc) {
          const result = collectDiagnostics(inputOf(doc), collectEnv(), semanticCache.get(doc.uri) ?? []);
          add(URI.parse(doc.uri).fsPath, result.raw, doc.doc.getText());
        } else {
          const disk = diskDiagnostics(file.uri);
          if (disk) add(URI.parse(file.uri).fsPath, disk.raw, disk.text);
        }
      }
      for (const folder of folders) Baseline.from(byRoot.get(folder) ?? []).save(folder);
      loadBaselines();
      // Tout ce qui vient d'être calculé est dans la baseline : rien à afficher, pas de seconde passe
      workspaceDiagnostics.clear(publishUri);
      for (const [root, list] of byRoot) for (const entry of list) setHidden(URI.file(path.join(root, entry.rel)).toString(), entry.diagnostics.length);
      for (const doc of documents.all()) publish(doc);
    }
    let entries = 0;
    for (const baseline of baselines.values()) entries += baseline.size;
    return { files: baselines.size, entries };
  }),
);

connection.onReferences(
  safe([], ({ textDocument, position, context }) => {
    const source = sourceOf(textDocument.uri);
    if (!source) return [];
    try {
      const variable = variableTarget(source.file, position);
      if (variable) return variableReferences(refEnv(), source.file, variable);
      const target = targetAt(refEnv(), source.file, position);
      return target ? findReferences(refEnv(), target, context.includeDeclaration) : [];
    } finally {
      source.release();
    }
  }),
);

const libraryUri = (uri: string) => uri.startsWith('file:') && isLibrary(URI.parse(uri).fsPath, folders, settings.libraryPaths, composerDirs);

/** Renommage : le refus métier remonte à VS Code (message affiché), les autres erreurs sont journalisées. */
function renameHandler<P extends { textDocument: { uri: string } }, R>(run: (file: SourceFile, params: P) => R | { error: string }) {
  return (params: P): R | ResponseError<void> | null => {
    const source = sourceOf(params.textDocument.uri);
    if (!source) return null;
    try {
      const result = run(source.file, params);
      if (result && typeof result === 'object' && 'error' in result) return new ResponseError(ErrorCodes.InvalidRequest, (result as { error: string }).error);
      return result as R;
    } catch (err) {
      connection.console.error(String((err as Error)?.stack ?? err));
      return null;
    } finally {
      source.release();
    }
  };
}

connection.onPrepareRename(renameHandler((file, { position }) => prepareRename(refEnv(), file, position, libraryUri)));
connection.onRenameRequest(renameHandler((file, { position, newName }) => renameAt(refEnv(), file, position, newName, libraryUri)));

connection.listen();
