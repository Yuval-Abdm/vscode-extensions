// PHP Forge (client VS Code) : démarre le serveur de langage, transmet les réglages, affiche la version de PHP
// utilisée, commandes, cohabitation avec d'autres extensions PHP.
import * as vscode from 'vscode';
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';
import type { Level } from '../server/diagnostics/policy.ts';
import { IncludeTreeProvider } from './includeTree.ts';
import { BASELINE_REQUEST, BASELINE_STATUS_NOTIFICATION, INCLUDE_TREE_REQUEST, INCLUDERS_REQUEST, REINDEX_REQUEST, STATUS_NOTIFICATION, type BaselineResult, type BaselineStatus, type IncludeLink, type IncludeTree, type InitOptions, type PhpVersionSource, type Settings, type StatusParams } from '../shared/protocol.ts';

/** Extensions PHP dont la complétion et les diagnostics feraient doublon. */
const COMPETITORS = ['bmewburn.vscode-intelephense-client', 'DEVSENSE.phptools-vscode'];

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const serverModule = context.asAbsolutePath('dist/server.cjs');
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6029'] } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'php' },
      { scheme: 'untitled', language: 'php' },
    ],
    synchronize: {
      configurationSection: 'phpForge',
      fileEvents: [
        vscode.workspace.createFileSystemWatcher('**/*.{php,php4,php5,phtml,ctp}'),
        // Dossiers créés, renommés ou supprimés : l'éditeur ne signale que le dossier, pas ses fichiers
        vscode.workspace.createFileSystemWatcher('**/*', false, true, false),
      ],
    },
    // Liens « Appliquer » du survol des problèmes : seule cette commande est autorisée
    markdown: { isTrusted: { enabledCommands: ['phpForge.applyFix'] } },
    initializationOptions: (): InitOptions => ({
      storagePath: (context.storageUri ?? context.globalStorageUri).fsPath,
      l10nBundle: vscode.l10n.uri?.fsPath,
      settings: readSettings(),
    }),
  };
  client = new LanguageClient('phpForge', 'PHP Forge', serverOptions, clientOptions);

  const status = vscode.languages.createLanguageStatusItem('phpForge.phpVersion', { language: 'php' });
  status.name = 'PHP Forge';
  status.text = 'PHP';
  status.command = { title: vscode.l10n.t('Change'), command: 'workbench.action.openSettings', arguments: ['phpForge.phpVersion'] };
  client.onNotification(STATUS_NOTIFICATION, (params: StatusParams) => {
    status.text = `PHP ${params.phpVersion}`;
    status.detail = sourceLabel(params.source);
  });
  const baselineStatus = vscode.languages.createLanguageStatusItem('phpForge.baseline', { language: 'php' });
  baselineStatus.name = vscode.l10n.t('PHP Forge baseline');
  baselineStatus.text = '';
  client.onNotification(BASELINE_STATUS_NOTIFICATION, (params: BaselineStatus) => {
    baselineStatus.text = params.active ? vscode.l10n.t('{0} problems hidden by the baseline', params.hidden) : vscode.l10n.t('No baseline');
    baselineStatus.command = params.active ? { title: vscode.l10n.t('Update'), command: 'phpForge.updateBaseline' } : { title: vscode.l10n.t('Create'), command: 'phpForge.createBaseline' };
  });
  const baseline = async (action: 'create' | 'update' | 'clear') => {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('PHP Forge: analyzing the workspace…') },
      () => client!.sendRequest<BaselineResult>(BASELINE_REQUEST, { action }),
    );
    const message = action === 'clear' ? vscode.l10n.t('Baseline cleared: all problems are shown again.') : vscode.l10n.t('Baseline saved: {0} existing problems are hidden.', result.entries);
    void vscode.window.showInformationMessage(message);
  };

  const tree = new IncludeTreeProvider(async (uri) => (await client?.sendRequest<IncludeTree>(INCLUDE_TREE_REQUEST, { uri })) ?? { includedBy: [], includes: [] });
  const followEditor = (editor: vscode.TextEditor | undefined) => {
    if (editor?.document.languageId === 'php') tree.setRoot(editor.document.uri.toString());
  };
  followEditor(vscode.window.activeTextEditor);

  context.subscriptions.push(
    status,
    baselineStatus,
    vscode.commands.registerCommand('phpForge.createBaseline', () => baseline('create')),
    vscode.commands.registerCommand('phpForge.updateBaseline', () => baseline('update')),
    vscode.commands.registerCommand('phpForge.clearBaseline', () => baseline('clear')),
    vscode.window.createTreeView('phpForge.includeTree', { treeDataProvider: tree, showCollapseAll: true }),
    vscode.window.onDidChangeActiveTextEditor(followEditor),
    vscode.commands.registerCommand('phpForge.showIncludeTree', () => vscode.commands.executeCommand('phpForge.includeTree.focus')),
    vscode.commands.registerCommand('phpForge.showIncluders', (uri: string) => showIncluders(uri)),
    vscode.commands.registerCommand('phpForge.restartServer', () => client?.restart()),
    vscode.commands.registerCommand('phpForge.reindex', () => client?.sendRequest(REINDEX_REQUEST)),
    vscode.commands.registerCommand('phpForge.showOutput', () => client?.outputChannel.show()),
    vscode.commands.registerCommand('phpForge.applyFix', (args: ApplyFixArgs) => applyFix(args)),
    vscode.commands.registerCommand('phpForge.showReferences', (uri: string, position: { line: number; character: number }, locations: { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }[]) =>
      vscode.commands.executeCommand(
        'editor.action.showReferences',
        vscode.Uri.parse(uri),
        new vscode.Position(position.line, position.character),
        locations.map((l) => new vscode.Location(vscode.Uri.parse(l.uri), new vscode.Range(l.range.start.line, l.range.start.character, l.range.end.line, l.range.end.character))),
      )),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('phpForge.exclude') || e.affectsConfiguration('phpForge.maxFileSize')) void client?.restart();
    }),
  );
  await client.start();
  void warnAboutCompetitors(context);
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}

function sourceLabel(source: PhpVersionSource): string {
  switch (source) {
    case 'setting':
      return vscode.l10n.t('from settings');
    case 'composer':
      return vscode.l10n.t('from composer.json');
    case 'php':
      return vscode.l10n.t('from the php executable');
    case 'default':
      return vscode.l10n.t('default version');
  }
}

function readSettings(): Partial<Settings> {
  const config = vscode.workspace.getConfiguration('phpForge');
  const settings: Partial<Settings> = {
    phpVersion: config.get<string>('phpVersion') ?? '',
    inlayHints: {
      parameterNames: config.get<boolean>('inlayHints.parameterNames', true),
      variableTypes: config.get<boolean>('inlayHints.variableTypes', false),
      returnTypes: config.get<boolean>('inlayHints.returnTypes', false),
    },
    documentRoot: config.get<string>('documentRoot') ?? '',
    serverRoot: config.get<string>('serverRoot') ?? '',
    includes: { maxContexts: config.get<number>('includes.maxContexts', 64) },
    externalGlobals: config.get<string[]>('externalGlobals') ?? [],
    diagnostics: {
      rules: config.get<Record<string, Level>>('diagnostics.rules') ?? {},
      scope: config.get<'openFiles' | 'workspace'>('diagnostics.scope') ?? 'workspace',
    },
    libraryPaths: config.get<string[]>('libraryPaths') ?? ['**/vendor/**', '**/PHPExcel/**', '**/Google/Api/**'],
    organizeUsesOnSave: config.get<boolean>('organizeUsesOnSave', false),
    completion: { autoImport: config.get<boolean>('completion.autoImport', true) },
    codeLens: { references: config.get<boolean>('codeLens.references', true), implementations: config.get<boolean>('codeLens.implementations', true) },
  };
  const exclude = config.get<string[]>('exclude');
  const maxFileSize = config.get<number>('maxFileSize');
  const stubs = config.get<string[]>('stubs');
  if (exclude) settings.exclude = exclude;
  if (maxFileSize) settings.maxFileSize = maxFileSize;
  if (stubs) settings.stubs = stubs;
  return settings;
}

async function warnAboutCompetitors(context: vscode.ExtensionContext): Promise<void> {
  for (const id of COMPETITORS) {
    const extension = vscode.extensions.getExtension(id);
    const key = `competitor.dismissed.${id}`;
    if (!extension || context.globalState.get(key)) continue;
    const show = vscode.l10n.t('Show extension');
    const never = vscode.l10n.t("Don't show again");
    const name = String(extension.packageJSON.displayName ?? id);
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t('{0} is also enabled: completions and diagnostics will be duplicated. You can disable it for this workspace.', name),
      show,
      never,
    );
    if (choice === show) await vscode.commands.executeCommand('extension.open', id);
    else if (choice === never) await context.globalState.update(key, true);
  }
}

interface ApplyFixArgs {
  uri: string;
  version: number;
  edits: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }[];
}

/**
 * Correction proposée dans le survol d'une ligne : appliquée telle quelle au document, puis le survol est fermé.
 * Calculée pour une version précise : un second clic (document déjà modifié) ne fait rien.
 */
async function applyFix({ uri, version, edits }: ApplyFixArgs): Promise<boolean> {
  void vscode.commands.executeCommand('editor.action.hideHover');
  const target = vscode.Uri.parse(uri);
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === target.toString());
  if (!doc || doc.version !== version) return false;
  const edit = new vscode.WorkspaceEdit();
  for (const e of edits) {
    edit.replace(target, new vscode.Range(e.range.start.line, e.range.start.character, e.range.end.line, e.range.end.character), e.newText);
  }
  return vscode.workspace.applyEdit(edit);
}

/** Liste des appelants d'un fichier (CodeLens « Included by N files ») : ouvre l'include choisi. */
async function showIncluders(uri: string): Promise<void> {
  const links = (await client?.sendRequest<IncludeLink[]>(INCLUDERS_REQUEST, { uri })) ?? [];
  const pick = await vscode.window.showQuickPick(
    links.map((link) => ({ label: link.label, link })),
    { placeHolder: vscode.l10n.t('Files that include this file') },
  );
  if (!pick) return;
  const editor = await vscode.window.showTextDocument(vscode.Uri.parse(pick.link.uri));
  const position = new vscode.Position(pick.link.line, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}
