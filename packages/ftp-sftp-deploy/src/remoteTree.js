// @ts-check
// Vue « Serveur distant » : parcours du serveur de chaque profil, avec création / renommage / suppression, et
// recherche de fichiers (ligne « Rechercher un fichier… » en tête de chaque serveur, résultats à la place des dossiers).
const vscode = require('vscode');
const path = require('path');
const { remoteUri } = require('./remoteFs');
const { fuzzyMatch } = require('./fuzzy');

/** Résultats affichés au plus ; au-delà, il faut préciser la recherche. */
const SHOWN = 200;

/**
 * @typedef {import('./config').Profile} Profile
 * @typedef {{ kind: 'profile', profile: Profile }
 *   | { kind: 'entry', profile: Profile, path: string, type: 'file' | 'dir', match?: number[] }
 *   | { kind: 'search', profile: Profile }
 *   | { kind: 'clearSearch', profile: Profile }
 *   | { kind: 'more', profile: Profile, count: number }
 *   | { kind: 'error', profile: Profile, message: string, parent: RemoteNode }} RemoteNode
 * `match` : résultat de recherche, positions des lettres trouvées dans le chemin relatif à la racine distante.
 */

class RemoteTreeProvider {
  /**
   * @param {import('./config').ConfigManager} config
   * @param {import('./remoteFs').RemoteFileSystem} remoteFs
   * @param {import('./remoteSearch').RemoteSearch} search
   */
  constructor(config, remoteFs, search) {
    this.config = config;
    this.remoteFs = remoteFs;
    this.search = search;
    /** @type {Map<string, string>} recherche en cours par id de profil */
    this.filters = new Map();
    /** @type {Map<string, number>} nombre de résultats de la dernière recherche affichée */
    this.counts = new Map();
    /** @type {Map<string, RemoteNode>} nœuds des serveurs, conservés : seul le serveur en recherche est redessiné */
    this.profileNodes = new Map();
    /** @type {Map<string, () => void>} */
    this.listeners = new Map();
    // Liste vidée (modification sur le serveur) : les résultats affichés sont recalculés sur une nouvelle liste.
    search.onDidReset(() => {
      for (const id of this.filters.keys()) this.refresh(this.profileNodes.get(id));
    });
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

  /** Recherche du serveur (texte vide : retour aux dossiers). @param {Profile} profile @param {string} query */
  setFilter(profile, query) {
    if (query.trim()) this.filters.set(profile.id, query);
    else this.filters.delete(profile.id);
    this.refresh(this.profileNodes.get(profile.id));
  }

  /** @param {Profile} profile */
  filterOf(profile) {
    return this.filters.get(profile.id);
  }

  /** @param {RemoteNode} [node] @returns {Promise<RemoteNode[]>} */
  async getChildren(node) {
    if (!node) {
      const profiles = this.config.profiles();
      const nodes = new Map(profiles.map((profile) => {
        const known = this.profileNodes.get(profile.id);
        if (known) known.profile = profile;
        return [profile.id, known ?? /** @type {RemoteNode} */ ({ kind: 'profile', profile })];
      }));
      this.profileNodes = nodes;
      return [...nodes.values()];
    }
    if (node.kind === 'profile' && this.filters.has(node.profile.id)) return this.results(node);
    if (node.kind !== 'profile' && node.kind !== 'entry') return [];
    if (node.kind === 'entry' && node.type === 'file') return [];
    /** @type {RemoteNode[]} */
    const head = node.kind === 'profile' ? [{ kind: 'search', profile: node.profile }] : [];
    const dir = node.kind === 'profile' ? node.profile.remotePath : node.path;
    try {
      const entries = await this.remoteFs.readDirectory(remoteUri(node.profile, dir));
      return head.concat(entries
        .map(([name, type]) => /** @type {RemoteNode} */ ({
          kind: 'entry', profile: node.profile, path: path.posix.join(dir, name), type: type === vscode.FileType.Directory ? 'dir' : 'file',
        }))
        .sort((a, b) => (a.type === b.type ? path.posix.basename(a.path).localeCompare(path.posix.basename(b.path)) : a.type === 'dir' ? -1 : 1)));
    } catch (err) {
      return head.concat([{ kind: 'error', profile: node.profile, message: err?.message ?? String(err), parent: node }]);
    }
  }

  /** Serveur en recherche : ligne de recherche, « Effacer la recherche », puis les fichiers trouvés. */
  results(node) {
    const { profile } = node;
    const listing = this.search.listing(profile);
    let listener = this.listeners.get(profile.id);
    if (!listener) {
      listener = () => this.filters.has(profile.id) && this.refresh(this.profileNodes.get(profile.id));
      this.listeners.set(profile.id, listener);
    }
    listing.listeners.add(listener);
    /** @type {RemoteNode[]} */
    const rows = [{ kind: 'search', profile }, { kind: 'clearSearch', profile }];
    if (listing.error) return rows.concat([{ kind: 'error', profile, message: listing.error, parent: node }]);
    const matches = fuzzyMatch(this.filters.get(profile.id) ?? '', listing.files, Infinity);
    for (const m of matches.slice(0, SHOWN)) {
      rows.push({ kind: 'entry', profile, path: path.posix.join(profile.remotePath, m.path), type: 'file', match: m.positions });
    }
    if (matches.length > SHOWN) rows.push({ kind: 'more', profile, count: matches.length - SHOWN });
    this.counts.set(profile.id, matches.length);
    return rows;
  }

  /** Pour `reveal` : parent d'un nœud. @param {RemoteNode} node @returns {RemoteNode | undefined} */
  getParent(node) {
    if (node.kind === 'profile') return undefined;
    const profileNode = this.profileNodes.get(node.profile.id) ?? /** @type {RemoteNode} */ ({ kind: 'profile', profile: node.profile });
    if (node.kind !== 'entry' || node.match) return profileNode;
    const dir = path.posix.dirname(node.path);
    return dir === node.profile.remotePath || !dir.startsWith(node.profile.remotePath) ? profileNode : { kind: 'entry', profile: node.profile, path: dir, type: 'dir' };
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
    if (node.kind === 'search') {
      const query = this.filters.get(node.profile.id);
      const command = { command: 'ftpSftpDeploy.remote.search', title: vscode.l10n.t('Search a file…'), arguments: [node] };
      if (query === undefined) {
        const item = new vscode.TreeItem(vscode.l10n.t('Search a file…'));
        item.id = `search:${node.profile.id}`;
        item.iconPath = new vscode.ThemeIcon('search');
        item.tooltip = vscode.l10n.t('Type part of the name or path: letters in order, e.g. "usrctl" for UserController.php.');
        item.command = command;
        item.contextValue = 'remoteSearch';
        return item;
      }
      const listing = this.search.cache.get(node.profile.id);
      const reading = listing && !listing.done;
      const count = this.counts.get(node.profile.id) ?? 0;
      const item = new vscode.TreeItem(`« ${query} »`);
      item.id = `search:${node.profile.id}`;
      item.iconPath = new vscode.ThemeIcon(reading ? 'loading~spin' : 'search');
      item.description = reading
        ? vscode.l10n.t('reading the server… {0} files', listing.files.length)
        : listing?.truncated
          ? vscode.l10n.t('{0} results (only the first {1} files are searched)', count, listing.files.length)
          : count === 1 ? vscode.l10n.t('1 result') : vscode.l10n.t('{0} results', count);
      item.tooltip = vscode.l10n.t('Click to change the search');
      item.command = command;
      item.contextValue = 'remoteSearch';
      return item;
    }
    if (node.kind === 'clearSearch') {
      const item = new vscode.TreeItem(vscode.l10n.t('Clear the search'));
      item.id = `clearSearch:${node.profile.id}`;
      item.iconPath = new vscode.ThemeIcon('close');
      item.tooltip = vscode.l10n.t('Back to the server folders');
      item.command = { command: 'ftpSftpDeploy.remote.clearSearch', title: vscode.l10n.t('Clear the search'), arguments: [node] };
      return item;
    }
    if (node.kind === 'more') {
      const item = new vscode.TreeItem(vscode.l10n.t('… {0} more: refine the search', node.count));
      item.id = `more:${node.profile.id}`;
      item.command = { command: 'ftpSftpDeploy.remote.search', title: vscode.l10n.t('Search a file…'), arguments: [node] };
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
    item.id = `${node.match ? 'match' : 'entry'}:${node.profile.id}:${node.path}`;
    item.contextValue = isDir ? 'remoteDir' : 'remoteFile';
    item.tooltip = node.path;
    if (node.match) {
      // Résultat de recherche : nom avec les lettres trouvées en gras, dossier à côté.
      const rel = path.posix.relative(node.profile.remotePath, node.path);
      const nameStart = rel.lastIndexOf('/') + 1;
      const name = rel.slice(nameStart);
      const highlights = /** @type {[number, number][]} */ (node.match.filter((i) => i >= nameStart).map((i) => [i - nameStart, i - nameStart + 1]));
      item.label = { label: name, highlights };
      item.description = nameStart ? rel.slice(0, nameStart - 1) : '';
    }
    if (!isDir) item.command = { command: 'vscode.open', title: vscode.l10n.t('Open'), arguments: [uri] };
    return item;
  }
}

/**
 * Commandes de la vue distante.
 * @param {RemoteTreeProvider} provider
 * @param {vscode.TreeView<RemoteNode>} view
 * @param {import('./deployer').Deployer} deployer
 */
function registerRemoteCommands(provider, view, deployer) {
  const filtered = () => provider.config.profiles().filter((p) => provider.filterOf(p) !== undefined);
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
    // « Actualiser » relit aussi la liste des serveurs en recherche.
    refresh: (node) => {
      const profiles = node ? [node.profile] : filtered();
      for (const p of profiles) if (provider.filterOf(p) !== undefined) provider.search.forget(p);
      provider.refresh(node?.kind === 'error' ? node.parent : node?.kind === 'search' || node?.kind === 'clearSearch' ? provider.profileNodes.get(node.profile.id) : node);
    },

    // Saisie de la recherche : les résultats s'affichent dans l'arbre pendant la frappe. Depuis la palette : serveur
    // du profil actif (ou au choix).
    search: async (node) => {
      let profile = node?.profile;
      if (!profile) {
        const profiles = provider.config.profiles();
        const actives = profiles.filter((p) => provider.config.active(p.folder)?.id === p.id);
        const candidates = actives.length === 1 ? actives : profiles;
        profile = candidates.length === 1
          ? candidates[0]
          : (await vscode.window.showQuickPick(
            candidates.map((p) => ({ label: p.name, description: `${p.protocol}://${p.host}${p.remotePath}`, p })),
            { placeHolder: vscode.l10n.t('Search on which server?') },
          ))?.p;
        if (!profile) return;
      }
      const target = profile;
      const profileNode = provider.profileNodes.get(target.id);
      if (profileNode) await view.reveal(profileNode, { expand: true, focus: false, select: false });
      const input = vscode.window.createInputBox();
      input.title = vscode.l10n.t('Search a file on {0}', target.name);
      input.placeholder = vscode.l10n.t('Part of the name or path, letters in order (e.g. "usrctl")');
      input.prompt = vscode.l10n.t('Results appear in the Remote Server view. Enter: close this box; empty: back to the folders.');
      input.value = provider.filterOf(target) ?? '';
      let timer;
      input.onDidChangeValue((value) => {
        clearTimeout(timer);
        timer = setTimeout(() => provider.setFilter(target, value), 120);
      });
      input.onDidAccept(() => input.hide());
      input.onDidHide(() => {
        clearTimeout(timer);
        provider.setFilter(target, input.value);
        input.dispose();
      });
      input.show();
    },

    clearSearch: (node) => node && provider.setFilter(node.profile, ''),

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
