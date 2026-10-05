// PHP Forge (client VS Code) : démarre le serveur de langage, transmet les réglages, affiche la version de PHP
// utilisée, commandes, cohabitation avec d'autres extensions PHP.
import * as vscode from 'vscode';
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';
import type { Level } from '../server/diagnostics/policy.ts';
import { deployChanged, ImpactProvider } from './impactView.ts';
import { IncludeTreeProvider } from './includeTree.ts';
import { mysqlDriver } from './mysql.ts';
import { connectionKey, fetchSchema, isAccessDenied, missingFields, type ConnectionSettings } from './sqlSchema.ts';
import { BASELINE_REQUEST, BASELINE_STATUS_NOTIFICATION, IMPACT_REQUEST, INCLUDE_TREE_REQUEST, INCLUDERS_REQUEST, MIGRATION_REPORT_REQUEST, REINDEX_REQUEST, STATUS_NOTIFICATION, type BaselineResult, type BaselineStatus, type ImpactEntry, type IncludeLink, type IncludeTree, type InitOptions, type PhpVersionSource, type Settings, type StatusParams } from '../shared/protocol.ts';

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
        // Schéma SQL : fichiers .sql et cache de la base
        vscode.workspace.createFileSystemWatcher('**/*.sql'),
        vscode.workspace.createFileSystemWatcher('**/.vscode/php-forge-schema.json'),
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

  // Vue « Impact » : pages à vérifier pour les fichiers modifiés ; déploiement si FTP SFTP Deploy est installée
  const impact = new ImpactProvider((uris) => client!.sendRequest<ImpactEntry[]>(IMPACT_REQUEST, { uris }));
  const impactView = vscode.window.createTreeView('phpForge.impact', { treeDataProvider: impact, showCollapseAll: true });
  impact.onTotal = (total) => {
    impactView.badge = total ? { value: total, tooltip: vscode.l10n.t('{0} changed PHP files', total) } : undefined;
  };
  const deployAvailable = () => vscode.commands.executeCommand('setContext', 'phpForge.deployAvailable', !!vscode.extensions.getExtension('yuval-abdm.ftp-sftp-deploy'));
  void deployAvailable();

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
    vscode.commands.registerCommand('phpForge.refreshSqlSchema', () => refreshSqlSchema(context)),
    vscode.commands.registerCommand('phpForge.migrationReport', () => showMigrationReport()),
    impactView,
    vscode.extensions.onDidChange(() => void deployAvailable()),
    vscode.commands.registerCommand('phpForge.refreshImpact', () => impact.refresh()),
    vscode.commands.registerCommand('phpForge.showImpact', () => vscode.commands.executeCommand('phpForge.impact.focus')),
    vscode.commands.registerCommand('phpForge.deployChanged', () => deployChanged(impact)),
    // Pour les tests de bout en bout : entrées affichées par la vue
    vscode.commands.registerCommand('phpForge.impactEntries', () => impact.entries),
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
  context.subscriptions.push(...(await impact.start()));
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
    format: {
      enable: config.get<boolean>('format.enable', true),
      braces: config.get<'psr12' | 'keep'>('format.braces', 'psr12'),
      alignArrows: config.get<boolean>('format.alignArrows', false),
      alignAssignments: config.get<boolean>('format.alignAssignments', false),
      trailingCommas: config.get<boolean>('format.trailingCommas', false),
      lineLength: config.get<number>('format.lineLength', 120),
    },
    security: { enabled: config.get<boolean>('security.enabled', true), sanitizers: config.get<string[]>('security.sanitizers') ?? [] },
    migration: { targetVersion: config.get<string>('migration.targetVersion') ?? '' },
    sql: { schema: config.get<string[]>('sql.schema') ?? ['sql/**/*.sql', 'migrations/**/*.sql', 'database/**/*.sql'] },
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

/**
 * Lit le schéma de la base (phpForge.sql.connection, mot de passe dans le SecretStorage) et l'écrit dans
 * `.vscode/php-forge-schema.json` du dossier (choisi en multi-root) : le serveur le relit. Échec : l'ancien schéma est conservé.
 */
async function refreshSqlSchema(context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    void vscode.window.showWarningMessage(vscode.l10n.t('Open a folder to refresh the SQL schema.'));
    return;
  }
  // Un schéma par dossier : en multi-root, choisir le projet
  const folder = folders.length > 1 ? await vscode.window.showWorkspaceFolderPick({ placeHolder: vscode.l10n.t('Project whose database schema to read') }) : folders[0];
  if (!folder) return;
  const config = vscode.workspace.getConfiguration('phpForge', folder.uri).get<Partial<ConnectionSettings>>('sql.connection') ?? {};
  const missing = missingFields(config);
  if (missing.length) {
    const open = vscode.l10n.t('Open settings');
    const choice = await vscode.window.showWarningMessage(vscode.l10n.t('Set {0} in phpForge.sql.connection to read the database schema.', missing.join(', ')), open);
    if (choice === open) await vscode.commands.executeCommand('workbench.action.openSettings', 'phpForge.sql.connection');
    return;
  }
  const connection: ConnectionSettings = { host: config.host!, port: config.port ?? 3306, user: config.user!, database: config.database! };
  const key = connectionKey(connection);
  let password = await context.secrets.get(key);
  if (password === undefined) {
    password = await vscode.window.showInputBox({
      password: true,
      ignoreFocusOut: true,
      prompt: vscode.l10n.t('Password of {0} (kept in VS Code secret storage)', `${connection.user}@${connection.host}`),
    });
    if (password === undefined) return;
  }
  try {
    const cache = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('PHP Forge: reading the SQL schema of {0}…', connection.database) },
      () => fetchSchema(() => mysqlDriver(connection, password!), connection.database, new Date()),
    );
    await context.secrets.store(key, password);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder.uri, '.vscode', 'php-forge-schema.json'), new TextEncoder().encode(`${JSON.stringify(cache, null, 1)}\n`));
    void vscode.window.showInformationMessage(vscode.l10n.t('SQL schema refreshed: {0} tables from {1}.', cache.tables.length, connection.database));
  } catch (err) {
    if (isAccessDenied(err)) await context.secrets.delete(key);
    void vscode.window.showWarningMessage(vscode.l10n.t('Could not read the SQL schema: {0}. The previous schema is kept.', (err as Error)?.message ?? String(err)));
  }
}

/** Rapport de migration du workspace (phpForge.migration.targetVersion), ouvert en Markdown. */
async function showMigrationReport(): Promise<void> {
  if (!vscode.workspace.getConfiguration('phpForge').get<string>('migration.targetVersion')) {
    const open = vscode.l10n.t('Open settings');
    const choice = await vscode.window.showWarningMessage(vscode.l10n.t('Set phpForge.migration.targetVersion to the PHP version you are migrating to.'), open);
    if (choice === open) await vscode.commands.executeCommand('workbench.action.openSettings', 'phpForge.migration.targetVersion');
    return;
  }
  const report = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('PHP Forge: analyzing the workspace…') },
    () => client!.sendRequest<string | undefined>(MIGRATION_REPORT_REQUEST),
  );
  if (!report) return;
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: report });
  await vscode.window.showTextDocument(doc);
}
