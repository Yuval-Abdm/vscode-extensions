// @ts-check
// Liste des fichiers de chaque serveur pour la recherche de la vue « Serveur distant ». Lue au premier usage (dossier
// par dossier, sans bloquer les uploads en attente), elle reste en mémoire jusqu'à une modification sur le serveur
// ou un clic sur « Relire ».
const vscode = require('vscode');
const path = require('path');
const { relativeRemote, isIgnored } = require('./paths');

const MAX_FILES = 50_000;

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

module.exports = { RemoteSearch, MAX_FILES };
