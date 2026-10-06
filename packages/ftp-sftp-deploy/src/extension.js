// @ts-check
// FTP SFTP Deploy : assemblage, commandes Explorateur/éditeur, barre d'état, upload à l'enregistrement, API publique.
const vscode = require('vscode');
const { ConfigManager } = require('./config');
const { ConnectionManager } = require('./connections');
const { RemoteFileSystem, SCHEME } = require('./remoteFs');
const { RemoteTreeProvider, registerRemoteCommands } = require('./remoteTree');
const { Deployer } = require('./deployer');
const { RemoteSearch } = require('./remoteSearch');

/** @param {vscode.ExtensionContext} context */
async function activate(context) {
  const log = vscode.window.createOutputChannel('FTP SFTP Deploy');
  const config = new ConfigManager(context, log);
  const connections = new ConnectionManager(config, log);
  const remoteFs = new RemoteFileSystem(config, connections);
  const deployer = new Deployer(config, connections, remoteFs, log);
  const remoteTree = new RemoteTreeProvider(config, remoteFs);
  const remoteSearch = new RemoteSearch(config, connections, remoteFs);
  const remoteView = vscode.window.createTreeView('ftpSftpDeploy.remote', { treeDataProvider: remoteTree, canSelectMany: true, showCollapseAll: true });

  // Barre d'état : profil actif du dossier de l'éditeur courant, clic = changer de profil
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'ftpSftpDeploy.switchProfile';
  const updateStatus = () => {
    const folder = currentFolder(config);
    const profile = folder && config.active(folder);
    if (!profile) return void status.hide();
    status.text = `$(cloud-upload) ${profile.name}`;
    status.tooltip = [
      vscode.l10n.t('Deploy: {0}', `${profile.protocol}://${profile.username}@${profile.host}${profile.remotePath}`),
      ...(profile.uploadOnSave ? [vscode.l10n.t('Upload on save enabled')] : []),
      vscode.l10n.t('Click to switch profile'),
    ].join('\n');
    status.show();
  };

  /** Fichiers ciblés par une commande d'Explorateur/éditeur : (uri, uris[]) ou éditeur actif. */
  const targetsOf = (uri, uris) => {
    if (Array.isArray(uris) && uris.length) return uris.filter((u) => u instanceof vscode.Uri);
    if (uri instanceof vscode.Uri) return [uri];
    const active = vscode.window.activeTextEditor?.document.uri;
    return active?.scheme === 'file' ? [active] : [];
  };

  const requireConfig = () => {
    if (config.hasConfig) return true;
    const create = vscode.l10n.t('Create configuration');
    vscode.window.showWarningMessage(vscode.l10n.t('No deployment profile: create .vscode/deploy.json.'), create, vscode.l10n.t('Import sftp.json'))
      .then((c) => c && vscode.commands.executeCommand(c === create ? 'ftpSftpDeploy.createConfig' : 'ftpSftpDeploy.importSftp'));
    return false;
  };

  const pickFolder = async () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length <= 1) return folders[0];
    return vscode.window.showWorkspaceFolderPick({ placeHolder: vscode.l10n.t('For which folder?') });
  };

  const commands = {
    upload: (uri, uris) => requireConfig() && deployer.upload(targetsOf(uri, uris)),
    download: (uri, uris) => requireConfig() && deployer.download(targetsOf(uri, uris)),
    diff: (uri) => requireConfig() && targetsOf(uri).slice(0, 1).forEach((u) => deployer.diff(u)),
    deleteRemote: (uri, uris) => requireConfig() && deployer.deleteRemote(targetsOf(uri, uris)),

    switchProfile: async () => {
      if (!requireConfig()) return;
      const folder = currentFolder(config) ?? (await pickFolder());
      if (!folder) return;
      const current = config.active(folder);
      const pick = await vscode.window.showQuickPick(
        config.profiles(folder).map((p) => ({
          label: `${p.id === current?.id ? '$(check) ' : ''}${p.name}`,
          description: `${p.protocol}://${p.host}${p.remotePath}`,
          name: p.name,
        })),
        { placeHolder: vscode.l10n.t('Active deployment profile ({0})', folder.name) },
      );
      if (pick) await config.setActive(folder, pick.name);
    },

    createConfig: async () => {
      const folder = await pickFolder();
      if (!folder) return void vscode.window.showWarningMessage(vscode.l10n.t('Open a folder first.'));
      if (config.profiles(folder).length) return void vscode.window.showTextDocument(config.configUri(folder));
      await config.createTemplate(folder);
    },

    openConfig: async () => {
      const folder = currentFolder(config) ?? (await pickFolder());
      if (folder) await vscode.commands.executeCommand('vscode.open', config.configUri(folder));
    },

    importSftp: async () => {
      const folder = await pickFolder();
      if (folder) await config.importSftpJson(folder);
    },

    migrateAll: () => config.migrateMany(),

    forgetPassword: async () => {
      const profiles = config.profiles();
      const pick = await vscode.window.showQuickPick(
        profiles.map((p) => ({ label: p.name, description: `${p.username}@${p.host}`, p })),
        { placeHolder: vscode.l10n.t('Forget the saved password of which profile?') },
      );
      if (!pick) return;
      await config.forgetPassword(pick.p);
      connections.disconnect(pick.p.id);
      vscode.window.showInformationMessage(vscode.l10n.t('Password forgotten for {0}.', `${pick.p.username}@${pick.p.host}`));
    },

    showLog: () => log.show(),
  };

  context.subscriptions.push(
    log, status, remoteView, connections, remoteSearch,
    vscode.workspace.registerFileSystemProvider(SCHEME, remoteFs, { isCaseSensitive: true }),
    ...registerRemoteCommands(remoteTree, remoteView, deployer, remoteSearch, config),
    ...Object.entries(commands).map(([id, fn]) => vscode.commands.registerCommand(`ftpSftpDeploy.${id}`, fn)),
    config.onDidChange(() => {
      connections.disconnectAll(); // les paramètres de connexion ont pu changer
      updateStatus();
    }),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    // Upload à l'enregistrement (option uploadOnSave du profil actif)
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== 'file') return;
      const profile = config.forUri(doc.uri);
      if (profile?.uploadOnSave) deployer.upload([doc.uri], { silent: true });
    }),
  );

  await config.reload();
  config.offerMigration(); // sans await : la notification attend la réponse de l'utilisateur

  /**
   * API publique (utilisée par Changed Files Explorer et les tests) :
   * `vscode.extensions.getExtension('yuval-abdm.ftp-sftp-deploy').exports`
   */
  return {
    version: 1,
    /** Au moins un profil configuré dans l'espace de travail. */
    hasConfig: () => config.hasConfig,
    onDidChangeConfig: config.onDidChange,
    /** Fichiers locaux → cibles distantes (profil actif, chemin relatif, chemin distant), hors exclusions. */
    resolve: (uris) => deployer.resolve(uris).targets.map((t) => ({ uri: t.uri, rel: t.rel, remote: t.remote, profile: t.profile.name, host: t.profile.host })),
    upload: (uris) => deployer.upload(uris),
    deleteRemote: (uris, options) => deployer.deleteRemote(uris, options),
    diff: (uri) => deployer.diff(uri),
    // Internes, pour les tests d'intégration
    _internals: { config, deployer, remoteTree, remoteSearch },
  };
}

function deactivate() {}

/** Dossier de l'éditeur actif, sinon le seul dossier configuré. */
function currentFolder(config) {
  const uri = vscode.window.activeTextEditor?.document.uri;
  const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
  if (folder && config.profiles(folder).length) return folder;
  const configured = (vscode.workspace.workspaceFolders ?? []).filter((f) => config.profiles(f).length);
  return configured.length === 1 ? configured[0] : folder ?? configured[0];
}

module.exports = { activate, deactivate };
