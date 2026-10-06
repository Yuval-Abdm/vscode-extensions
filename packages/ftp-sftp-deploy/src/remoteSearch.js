// @ts-check
// Recherche de fichiers sur le serveur, comme « Aller au fichier » (Ctrl+P) : la liste des fichiers du dossier est
// lue une fois (dossier par dossier, sans bloquer les uploads en attente), puis filtrée à la frappe par recherche
// floue. Elle reste en mémoire jusqu'à une modification sur le serveur ou un clic sur « Relire ».
const vscode = require('vscode');
const path = require('path');
const { remoteUri } = require('./remoteFs');
const { relativeRemote, isIgnored } = require('./paths');
const { fuzzyFilter } = require('./fuzzy');

const MAX_FILES = 50_000;
const SHOWN = 200;

/** @typedef {{ files: string[], done: boolean, truncated: boolean, error?: string, listeners: Set<() => void>, cancelled: boolean }} Listing */

class RemoteSearch {
  /**
   * @param {import('./config').ConfigManager} config
   * @param {import('./connections').ConnectionManager} connections
   * @param {import('./remoteFs').RemoteFileSystem} remoteFs
   */
  constructor(config, connections, remoteFs) {
    this.config = config;
    this.connections = connections;
    /** @type {Map<string, Listing>} clé : id du profil + dossier */
    this.cache = new Map();
    // Fichier créé, supprimé ou renommé sur le serveur : les listes sont relues à la prochaine recherche.
    this.disposables = [
      remoteFs.onDidChangeFile((events) => {
        if (events.some((e) => e.type !== vscode.FileChangeType.Changed)) this.clear();
      }),
      config.onDidChange(() => this.clear()),
    ];
  }

  dispose() {
    this.clear();
    for (const d of this.disposables) d.dispose();
  }

  clear() {
    for (const listing of this.cache.values()) listing.cancelled = true;
    this.cache.clear();
  }

  /**
   * Liste (en cours ou terminée) des fichiers sous `dir`, chemins relatifs à `dir`.
   * @param {import('./config').Profile} profile
   * @param {string} dir
   */
  listing(profile, dir) {
    const key = `${profile.id}\0${dir}`;
    let listing = this.cache.get(key);
    if (!listing) {
      listing = { files: [], done: false, truncated: false, listeners: new Set(), cancelled: false };
      this.cache.set(key, listing);
      void this.walk(profile, dir, listing);
    }
    return listing;
  }

  /** Parcours en largeur : une opération par dossier, qui laisse passer les autres opérations du profil entre deux. */
  async walk(profile, dir, listing) {
    const notify = () => listing.listeners.forEach((l) => l());
    const queue = [dir];
    let lastNotify = 0;
    try {
      while (queue.length && !listing.cancelled) {
        const current = /** @type {string} */ (queue.shift());
        const entries = await this.connections.run(profile, (c) => c.list(current));
        for (const entry of entries) {
          const full = path.posix.join(current, entry.name);
          // Exclusions du profil (.git, node_modules…), relatives à la racine distante.
          const rel = relativeRemote(profile.remotePath, full);
          if (rel && isIgnored(rel, profile.ignore)) continue;
          if (entry.type === 'dir') queue.push(full);
          else listing.files.push(path.posix.relative(dir, full));
        }
        if (listing.files.length >= MAX_FILES) {
          listing.truncated = true;
          break;
        }
        if (Date.now() - lastNotify > 300) {
          lastNotify = Date.now();
          notify();
        }
      }
    } catch (err) {
      listing.error = err?.message ?? String(err);
      // Erreur (connexion annulée…) : la prochaine recherche relira le serveur.
      this.cache.forEach((value, key) => value === listing && this.cache.delete(key));
    }
    listing.done = true;
    notify();
  }

  /**
   * Fenêtre de recherche sur le serveur du profil, dans `dir` (par défaut la racine distante du profil).
   * @param {import('./config').Profile} profile
   * @param {string} [dir]
   */
  async show(profile, dir = profile.remotePath) {
    const quickPick = vscode.window.createQuickPick();
    const reload = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: vscode.l10n.t('Read the server again') };
    const compare = { iconPath: new vscode.ThemeIcon('diff'), tooltip: vscode.l10n.t('Compare with local file') };
    quickPick.title = vscode.l10n.t('Search files on {0}', `${profile.name} · ${dir}`);
    quickPick.buttons = [reload];
    // Le dossier est surligné aussi quand la recherche y correspond.
    quickPick.matchOnDescription = true;

    let listing = this.listing(profile, dir);
    const render = () => {
      const matches = fuzzyFilter(quickPick.value, listing.files, SHOWN);
      quickPick.items = matches.map((rel) => {
        const parent = path.posix.dirname(rel);
        return {
          label: path.posix.basename(rel),
          description: parent === '.' ? '' : parent,
          // Tout ce que la recherche floue retient reste affiché, même si VS Code ne l'aurait pas retenu.
          alwaysShow: true,
          buttons: [compare],
          rel,
        };
      });
      quickPick.busy = !listing.done;
      if (listing.error) quickPick.placeholder = vscode.l10n.t('Error: {0}', listing.error);
      else if (listing.truncated) quickPick.placeholder = vscode.l10n.t('Only the first {0} files are searched.', MAX_FILES);
      else if (!listing.done) quickPick.placeholder = vscode.l10n.t('Reading the server… {0} files', listing.files.length);
      else quickPick.placeholder = vscode.l10n.t('{0} files: name or part of the path (letters in order, e.g. "usrctl")', listing.files.length);
    };
    const follow = () => {
      listing.listeners.add(render);
      render();
    };
    follow();

    const uriOf = (item) => remoteUri(profile, path.posix.join(dir, item.rel));
    quickPick.onDidChangeValue(render);
    quickPick.onDidTriggerButton(() => {
      listing.listeners.delete(render);
      this.cache.delete(`${profile.id}\0${dir}`);
      listing.cancelled = true;
      listing = this.listing(profile, dir);
      follow();
    });
    quickPick.onDidTriggerItemButton(({ item }) => {
      void vscode.commands.executeCommand('ftpSftpDeploy.remote.diffWithLocal', { kind: 'entry', profile, type: 'file', path: path.posix.join(dir, /** @type {any} */ (item).rel) });
    });
    quickPick.onDidAccept(() => {
      const item = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
      if (!item) return;
      quickPick.hide();
      void vscode.commands.executeCommand('vscode.open', uriOf(item));
    });
    quickPick.onDidHide(() => {
      listing.listeners.delete(render);
      quickPick.dispose();
    });
    quickPick.show();
  }
}

module.exports = { RemoteSearch };
