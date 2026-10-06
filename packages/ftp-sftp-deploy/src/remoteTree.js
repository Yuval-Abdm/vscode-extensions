// @ts-check
// Vue « Serveur distant » : parcours du serveur de chaque profil, avec création / renommage / suppression.
const vscode = require('vscode');
const path = require('path');
const { remoteUri } = require('./remoteFs');

/**
 * @typedef {import('./config').Profile} Profile
 * @typedef {{ kind: 'profile', profile: Profile }
 *   | { kind: 'entry', profile: Profile, path: string, type: 'file' | 'dir' }
 *   | { kind: 'error', profile: Profile, message: string, parent: RemoteNode }} RemoteNode
 */

class RemoteTreeProvider {
  /**
   * @param {import('./config').ConfigManager} config
   * @param {import('./remoteFs').RemoteFileSystem} remoteFs
   */
  constructor(config, remoteFs) {
    this.config = config;
    this.remoteFs = remoteFs;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
    config.onDidChange(() => this.refresh());
    // Toute modification passée par le FileSystemProvider (éditeur, upload…) rafraîchit la vue,
    // regroupée pour ne pas relister le serveur à chaque fichier d'un upload en lot
    remoteFs.onDidChangeFile(() => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.refresh(), 1000);
    });
  }

  refresh(node) {
    this._onDidChange.fire(node);
  }

  /** @param {RemoteNode} [node] @returns {Promise<RemoteNode[]>} */
  async getChildren(node) {
    if (!node) return this.config.profiles().map((profile) => ({ kind: 'profile', profile }));
    if (node.kind === 'error' || (node.kind === 'entry' && node.type === 'file')) return [];
    const dir = node.kind === 'profile' ? node.profile.remotePath : node.path;
    try {
      const entries = await this.remoteFs.readDirectory(remoteUri(node.profile, dir));
      return entries
        .map(([name, type]) => /** @type {RemoteNode} */ ({
          kind: 'entry', profile: node.profile, path: path.posix.join(dir, name), type: type === vscode.FileType.Directory ? 'dir' : 'file',
        }))
        .sort((a, b) => (a.type === b.type ? path.posix.basename(a.path).localeCompare(path.posix.basename(b.path)) : a.type === 'dir' ? -1 : 1));
    } catch (err) {
      return [{ kind: 'error', profile: node.profile, message: err?.message ?? String(err), parent: node }];
    }
  }

  /** @param {RemoteNode} node */
  getTreeItem(node) {
    if (node.kind === 'profile') {
      const p = node.profile;
      const active = this.config.active(p.folder)?.id === p.id;
      const multiFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
      const item = new vscode.TreeItem(p.name, active ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `profile:${p.id}`;
      item.description = `${multiFolder ? `${p.folder.name} · ` : ''}${p.protocol}://${p.host}${p.remotePath}${active ? ` · ${vscode.l10n.t('active')}` : ''}`;
      item.tooltip = `${p.protocol}://${p.username}@${p.host}:${p.port}${p.remotePath}`;
      item.iconPath = new vscode.ThemeIcon(active ? 'cloud' : 'cloud-download');
      item.contextValue = 'remoteRoot';
      return item;
    }
    if (node.kind === 'error') {
      const item = new vscode.TreeItem(vscode.l10n.t('Error: {0}', node.message));
      item.iconPath = new vscode.ThemeIcon('error');
      item.tooltip = node.message;
      item.command = { command: 'ftpSftpDeploy.remote.refresh', title: vscode.l10n.t('Retry'), arguments: [node.parent] };
      return item;
    }
    const uri = remoteUri(node.profile, node.path);
    const isDir = node.type === 'dir';
    const item = new vscode.TreeItem(uri, isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = `entry:${node.profile.id}:${node.path}`;
    item.contextValue = isDir ? 'remoteDir' : 'remoteFile';
    item.tooltip = node.path;
    if (!isDir) item.command = { command: 'vscode.open', title: vscode.l10n.t('Open'), arguments: [uri] };
    return item;
  }
}

/**
 * Commandes de la vue distante.
 * @param {RemoteTreeProvider} provider
 * @param {vscode.TreeView<RemoteNode>} view
 * @param {import('./deployer').Deployer} deployer
 * @param {import('./remoteSearch').RemoteSearch} search
 * @param {import('./config').ConfigManager} config
 */
function registerRemoteCommands(provider, view, deployer, search, config) {
  const uriOf = (node) => remoteUri(node.profile, node.kind === 'profile' ? node.profile.remotePath : node.path);
  const dirOf = (node) => (node.kind === 'profile' ? node.profile.remotePath : node.type === 'dir' ? node.path : path.posix.dirname(node.path));
  const nodes = (node, all) => (all?.length ? all : node ? [node] : view.selection).filter((n) => n?.kind === 'entry' || n?.kind === 'profile');
  const nameRule = (v) => (!v.trim() ? vscode.l10n.t('The name cannot be empty') : /[\\/]/.test(v) ? vscode.l10n.t('The name cannot contain / or \\') : null);
  const fsApi = vscode.workspace.fs;

  const guard = (fn) => async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      vscode.window.showErrorMessage(err?.message ?? String(err));
    }
  };

  const commands = {
    refresh: (node) => provider.refresh(node?.kind === 'error' ? node.parent : node),

    newFile: async (node) => {
      if (!node) return;
      const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t('New file in {0}', dirOf(node)), validateInput: nameRule });
      if (!name) return;
      const uri = remoteUri(node.profile, path.posix.join(dirOf(node), name));
      await fsApi.writeFile(uri, new Uint8Array());
      await vscode.window.showTextDocument(uri);
    },

    newFolder: async (node) => {
      if (!node) return;
      const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t('New folder in {0}', dirOf(node)), validateInput: nameRule });
      if (name) await fsApi.createDirectory(remoteUri(node.profile, path.posix.join(dirOf(node), name)));
    },

    rename: async (node) => {
      if (node?.kind !== 'entry') return;
      const name = path.posix.basename(node.path);
      const dot = name.lastIndexOf('.');
      const newName = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('New name (on the server)'), value: name, valueSelection: [0, dot > 0 && node.type === 'file' ? dot : name.length], validateInput: nameRule,
      });
      if (!newName || newName === name) return;
      await fsApi.rename(uriOf(node), remoteUri(node.profile, path.posix.join(path.posix.dirname(node.path), newName)), { overwrite: false });
    },

    delete: async (node, all) => {
      const list = nodes(node, all).filter((n) => n.kind === 'entry');
      if (!list.length) return;
      const server = list[0].profile.name;
      const question = list.length > 1
        ? vscode.l10n.t('Permanently delete these {0} items from the server ({1})?', list.length, server)
        : list[0].type === 'dir'
          ? vscode.l10n.t('Permanently delete the folder "{0}" and all its contents from the server ({1})?', list[0].path, server)
          : vscode.l10n.t('Permanently delete the file "{0}" from the server ({1})?', list[0].path, server);
      const del = vscode.l10n.t('Delete from server');
      const ok = await vscode.window.showWarningMessage(`${question}\n\n${vscode.l10n.t('This cannot be undone.')}`, { modal: true }, del);
      if (ok !== del) return;
      for (const n of list) await fsApi.delete(uriOf(n), { recursive: true });
    },

    // Depuis un serveur ou un dossier : recherche dedans ; depuis le titre de la vue : serveur sélectionné, sinon profil
    // actif s'il n'y en a qu'un, sinon au choix.
    search: async (node) => {
      if (node?.kind === 'profile' || (node?.kind === 'entry' && node.type === 'dir')) return search.show(node.profile, dirOf(node));
      const selected = view.selection.find((n) => n.kind !== 'error');
      if (selected) return search.show(selected.profile, selected.kind === 'profile' ? undefined : dirOf(selected));
      const profiles = config.profiles();
      if (!profiles.length) return;
      const actives = profiles.filter((p) => config.active(p.folder)?.id === p.id);
      const candidates = actives.length === 1 ? actives : profiles;
      const profile = candidates.length === 1
        ? candidates[0]
        : (await vscode.window.showQuickPick(
          candidates.map((p) => ({ label: p.name, description: `${p.protocol}://${p.host}${p.remotePath}`, p })),
          { placeHolder: vscode.l10n.t('Search on which server?') },
        ))?.p;
      if (profile) await search.show(profile);
    },

    open: (node) => node?.kind === 'entry' && node.type === 'file' && vscode.commands.executeCommand('vscode.open', uriOf(node)),

    download: async (node, all) => {
      const locals = nodes(node, all).map((n) => deployer.localFor(n.profile, n.kind === 'profile' ? n.profile.remotePath : n.path)).filter(Boolean);
      if (!locals.length) return void vscode.window.showWarningMessage(vscode.l10n.t('This item is outside "remotePath": no matching local location.'));
      await deployer.download(locals);
    },

    diffWithLocal: async (node) => {
      if (node?.kind !== 'entry' || node.type !== 'file') return;
      const local = deployer.localFor(node.profile, node.path);
      if (!local) return void vscode.window.showWarningMessage(vscode.l10n.t('No matching local location.'));
      await vscode.commands.executeCommand('vscode.diff', uriOf(node), local, `${path.posix.basename(node.path)} (${node.profile.name} ↔ local)`);
    },

    revealLocal: async (node) => {
      const local = node?.kind === 'entry' && deployer.localFor(node.profile, node.path);
      if (local) await vscode.commands.executeCommand('revealInExplorer', local);
    },

    copyRemotePath: (node, all) => vscode.env.clipboard.writeText(nodes(node, all).map((n) => (n.kind === 'profile' ? n.profile.remotePath : n.path)).join('\n')),
  };

  return Object.entries(commands).map(([id, fn]) => vscode.commands.registerCommand(`ftpSftpDeploy.remote.${id}`, guard(fn)));
}

module.exports = { RemoteTreeProvider, registerRemoteCommands };
