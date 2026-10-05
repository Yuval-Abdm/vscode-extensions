// PHP Forge (client VS Code) : démarre le serveur de langage, transmet les réglages, affiche la version de PHP
// utilisée, commandes, cohabitation avec d'autres extensions PHP.
import * as vscode from 'vscode';
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';
import { REINDEX_REQUEST, STATUS_NOTIFICATION, type InitOptions, type PhpVersionSource, type Settings, type StatusParams } from '../shared/protocol.ts';

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

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand('phpForge.restartServer', () => client?.restart()),
    vscode.commands.registerCommand('phpForge.reindex', () => client?.sendRequest(REINDEX_REQUEST)),
    vscode.commands.registerCommand('phpForge.showOutput', () => client?.outputChannel.show()),
    vscode.commands.registerCommand('phpForge.applyFix', (args: ApplyFixArgs) => applyFix(args)),
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
