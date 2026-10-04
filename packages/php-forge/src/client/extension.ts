// PHP Forge (client VS Code) : démarre le serveur de langage, commandes, cohabitation avec d'autres extensions PHP.
import * as vscode from 'vscode';
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';
import { REINDEX_REQUEST, type InitOptions, type Settings } from '../shared/protocol.ts';

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
      fileEvents: [
        vscode.workspace.createFileSystemWatcher('**/*.{php,php4,php5,phtml,ctp}'),
        // Dossiers créés, renommés ou supprimés : l'éditeur ne signale que le dossier, pas ses fichiers
        vscode.workspace.createFileSystemWatcher('**/*', false, true, false),
      ],
    },
    initializationOptions: (): InitOptions => ({
      storagePath: (context.storageUri ?? context.globalStorageUri).fsPath,
      l10nBundle: vscode.l10n.uri?.fsPath,
      settings: readSettings(),
    }),
  };
  client = new LanguageClient('phpForge', 'PHP Forge', serverOptions, clientOptions);

  context.subscriptions.push(
    vscode.commands.registerCommand('phpForge.restartServer', () => client?.restart()),
    vscode.commands.registerCommand('phpForge.reindex', () => client?.sendRequest(REINDEX_REQUEST)),
    vscode.commands.registerCommand('phpForge.showOutput', () => client?.outputChannel.show()),
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

function readSettings(): Partial<Settings> {
  const config = vscode.workspace.getConfiguration('phpForge');
  const settings: Partial<Settings> = {};
  const exclude = config.get<string[]>('exclude');
  const maxFileSize = config.get<number>('maxFileSize');
  if (exclude) settings.exclude = exclude;
  if (maxFileSize) settings.maxFileSize = maxFileSize;
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
