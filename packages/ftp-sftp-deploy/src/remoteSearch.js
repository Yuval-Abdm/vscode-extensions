// @ts-check
// Section « Rechercher » : recherche de fichiers sur le serveur, comme « Aller au fichier » (Ctrl+P). La liste des
// fichiers est lue au premier usage (dossier par dossier, sans bloquer les uploads en attente), puis filtrée à la
// frappe par recherche floue. Elle reste en mémoire jusqu'à une modification sur le serveur ou un clic sur « Relire ».
const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const { remoteUri } = require('./remoteFs');
const { relativeRemote, isIgnored } = require('./paths');
const { fuzzyMatch } = require('./fuzzy');

const MAX_FILES = 50_000;
const SHOWN = 200;

/** @typedef {import('./config').Profile} Profile */
/** @typedef {{ files: string[], done: boolean, truncated: boolean, error?: string, listeners: Set<() => void>, cancelled: boolean }} Listing */

/** Listes des fichiers des serveurs, chemins relatifs à la racine distante du profil. */
class RemoteSearch {
  /**
   * @param {import('./config').ConfigManager} config
   * @param {import('./connections').ConnectionManager} connections
   * @param {import('./remoteFs').RemoteFileSystem} remoteFs
   */
  constructor(config, connections, remoteFs) {
    this.connections = connections;
    /** @type {Map<string, Listing>} clé : id du profil */
    this.cache = new Map();
    this._onDidReset = new vscode.EventEmitter();
    /** Listes vidées : à relire. */
    this.onDidReset = this._onDidReset.event;
    this.disposables = [
      // Fichier créé, supprimé ou renommé sur le serveur : la liste est relue.
      remoteFs.onDidChangeFile((events) => {
        if (events.some((e) => e.type !== vscode.FileChangeType.Changed)) this.clear();
      }),
      config.onDidChange(() => this.clear()),
      this._onDidReset,
    ];
  }

  dispose() {
    this.clear();
    for (const d of this.disposables) d.dispose();
  }

  clear() {
    for (const listing of this.cache.values()) listing.cancelled = true;
    this.cache.clear();
    this._onDidReset.fire();
  }

  /** @param {Profile} profile */
  forget(profile) {
    const listing = this.cache.get(profile.id);
    if (listing) listing.cancelled = true;
    this.cache.delete(profile.id);
  }

  /** Liste (en cours ou terminée) des fichiers du serveur du profil. @param {Profile} profile */
  listing(profile) {
    let listing = this.cache.get(profile.id);
    if (!listing) {
      listing = { files: [], done: false, truncated: false, listeners: new Set(), cancelled: false };
      this.cache.set(profile.id, listing);
      void this.walk(profile, listing);
    }
    return listing;
  }

  /** Parcours en largeur : une opération par dossier, qui laisse passer les autres opérations du profil entre deux. */
  async walk(profile, listing) {
    const notify = () => listing.listeners.forEach((l) => l());
    const root = profile.remotePath;
    const queue = [root];
    let lastNotify = 0;
    try {
      while (queue.length && !listing.cancelled) {
        const current = /** @type {string} */ (queue.shift());
        const entries = await this.connections.run(profile, (c) => c.list(current));
        for (const entry of entries) {
          const full = path.posix.join(current, entry.name);
          // Exclusions du profil (.git, node_modules…).
          const rel = relativeRemote(root, full);
          if (!rel || isIgnored(rel, profile.ignore)) continue;
          if (entry.type === 'dir') queue.push(full);
          else listing.files.push(rel);
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
      if (this.cache.get(profile.id) === listing) this.cache.delete(profile.id);
    }
    listing.done = true;
    notify();
  }
}

/** Section « Rechercher » de la barre latérale Deploy. */
class SearchView {
  /**
   * @param {RemoteSearch} search
   * @param {import('./config').ConfigManager} config
   * @param {vscode.Uri} extensionUri
   * @param {() => Profile | undefined} defaultProfile profil actif de l'éditeur courant
   */
  constructor(search, config, extensionUri, defaultProfile) {
    this.search = search;
    this.config = config;
    this.extensionUri = extensionUri;
    this.defaultProfile = defaultProfile;
    /** @type {vscode.WebviewView | undefined} */
    this.view = undefined;
    /** @type {string | undefined} */
    this.profileId = undefined;
    this.query = '';
    /** Lecture du serveur demandée (champ utilisé) : rien n'est lu tant que la section est seulement affichée. */
    this.started = false;
    /** @type {Listing | undefined} */
    this.listing = undefined;
    this.pendingFocus = false;
    this.render = () => this.postResults();
    this.disposables = [
      vscode.window.registerWebviewViewProvider('ftpSftpDeploy.search', this),
      config.onDidChange(() => this.postProfiles()),
      search.onDidReset(() => {
        this.detach();
        if (this.started && this.view?.visible) this.postResults();
      }),
    ];
  }

  dispose() {
    this.detach();
    for (const d of this.disposables) d.dispose();
  }

  /** @param {vscode.WebviewView} view */
  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((message) => this.receive(message));
    view.onDidChangeVisibility(() => {
      if (view.visible && this.started) this.postResults();
    });
    view.onDidDispose(() => {
      this.detach();
      this.view = undefined;
    });
  }

  /** Commande « Rechercher des fichiers sur le serveur » : affiche la section et place le curseur dans le champ. */
  async focus() {
    // Section pas encore chargée : le curseur y sera placé dès qu'elle est prête.
    this.pendingFocus = !this.view;
    await vscode.commands.executeCommand('ftpSftpDeploy.search.focus');
    this.post({ type: 'focus' });
  }

  /** @returns {Profile | undefined} */
  profile() {
    const profiles = this.config.profiles();
    return profiles.find((p) => p.id === this.profileId) ?? this.defaultProfile() ?? profiles[0];
  }

  receive(message) {
    switch (message.type) {
      case 'ready':
        this.postProfiles();
        if (this.pendingFocus) this.post({ type: 'focus' });
        this.pendingFocus = false;
        break;
      case 'start':
        this.started = true;
        this.postResults();
        break;
      case 'profile':
        this.profileId = message.id;
        this.detach();
        if (this.started) this.postResults();
        break;
      case 'query':
        this.query = String(message.value ?? '');
        this.started = true;
        this.postResults();
        break;
      case 'reload': {
        const profile = this.profile();
        if (!profile) return;
        this.detach();
        this.search.forget(profile);
        this.started = true;
        this.postResults();
        break;
      }
      case 'open':
      case 'compare': {
        const profile = this.profile();
        if (!profile || typeof message.path !== 'string') return;
        const remote = path.posix.join(profile.remotePath, message.path);
        if (message.type === 'open') void vscode.commands.executeCommand('vscode.open', remoteUri(profile, remote), { preview: !message.pin });
        else void vscode.commands.executeCommand('ftpSftpDeploy.remote.diffWithLocal', { kind: 'entry', profile, type: 'file', path: remote });
        break;
      }
    }
  }

  /** Ne suit plus la liste en cours (autre serveur, liste vidée). */
  detach() {
    this.listing?.listeners.delete(this.render);
    this.listing = undefined;
  }

  postProfiles() {
    const profiles = this.config.profiles();
    const current = this.profile();
    const multiFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    this.post({
      type: 'profiles',
      selected: current?.id,
      profiles: profiles.map((p) => ({ id: p.id, label: `${multiFolder ? `${p.folder.name} · ` : ''}${p.name} — ${p.host}${p.remotePath}` })),
    });
    if (this.listing && this.listing !== (current && this.search.cache.get(current.id))) this.detach();
    if (this.started) this.postResults();
  }

  postResults() {
    if (!this.view) return;
    const profile = this.profile();
    if (!profile) return void this.post({ type: 'results', items: [], status: { kind: 'none' } });
    if (!this.listing) {
      this.listing = this.search.listing(profile);
      this.listing.listeners.add(this.render);
    }
    const listing = this.listing;
    const items = fuzzyMatch(this.query, listing.files, SHOWN);
    const status = listing.error
      ? { kind: 'error', text: vscode.l10n.t('Error: {0}', listing.error) }
      : !listing.done
        ? { kind: 'busy', text: vscode.l10n.t('Reading the server… {0} files', listing.files.length) }
        : listing.truncated
          ? { kind: 'done', text: vscode.l10n.t('Only the first {0} files are searched.', MAX_FILES) }
          : { kind: 'done', text: vscode.l10n.t('{0} files on the server', listing.files.length) };
    this.post({ type: 'results', query: this.query, items, status, more: this.query ? false : listing.files.length > SHOWN });
  }

  post(message) {
    void this.view?.webview.postMessage(message);
  }

  /** @param {vscode.Webview} webview @param {vscode.Uri} media */
  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const text = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const strings = {
      compare: vscode.l10n.t('Compare with local file'),
      reload: vscode.l10n.t('Read the server again'),
      noResult: vscode.l10n.t('No file matches.'),
      noServer: vscode.l10n.t('No server configured.'),
      hint: vscode.l10n.t('Type part of the name or path: letters in order, e.g. "usrctl" for UserController.php.'),
      more: vscode.l10n.t('Type to filter.'),
    };
    const json = JSON.stringify(strings).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="${text(vscode.env.language)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(media, 'search.css'))}">
</head>
<body>
<div class="bar">
  <select id="profile" title="${text(vscode.l10n.t('Server'))}" hidden></select>
  <div class="field">
    <input id="query" type="text" spellcheck="false" autocomplete="off" placeholder="${text(vscode.l10n.t('Search files on the server'))}" aria-label="${text(vscode.l10n.t('Search files on the server'))}">
    <button id="reload" type="button" title="${text(strings.reload)}" aria-label="${text(strings.reload)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3"/></svg></button>
  </div>
  <div id="status"></div>
</div>
<ul id="results" role="listbox"></ul>
<script id="strings" type="application/json">${json}</script>
<script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(media, 'search.js'))}"></script>
</body>
</html>`;
  }
}

module.exports = { RemoteSearch, SearchView };
