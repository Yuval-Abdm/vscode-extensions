// @ts-check
// Copie de la version serveur des fichiers avant leur remplacement/suppression, pour pouvoir annuler un lot d'envois.
// Un lot est identifié par une « session » choisie par l'appelant (ex. : le commit HEAD) : changer de session
// repart d'une sauvegarde vide. Dans une session, seule la première version vue d'un fichier est gardée.
// Aucune dépendance à vscode.
const fs = require('fs');
const path = require('path');

/**
 * @typedef {{ profileId: string, profileName: string, remote: string, existed: boolean, file?: string }} BackupEntry
 *   existed = false : le fichier n'existait pas sur le serveur (l'annulation le supprime)
 */

class BackupStore {
  /** @param {string} dir dossier local de la sauvegarde */
  constructor(dir) {
    this.dir = dir;
    /** @type {string | undefined} */
    this.session = undefined;
    /** @type {BackupEntry[]} */
    this.entries = [];
    this.listeners = [];
  }

  get manifest() {
    return path.join(this.dir, 'manifest.json');
  }

  async load() {
    try {
      const json = JSON.parse(await fs.promises.readFile(this.manifest, 'utf8'));
      this.session = json.session;
      this.entries = Array.isArray(json.entries) ? json.entries : [];
    } catch {
      this.session = undefined;
      this.entries = [];
    }
    this.emit();
  }

  /** @param {() => void} cb */
  onDidChange(cb) {
    this.listeners.push(cb);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== cb)) };
  }

  emit() {
    this.listeners.forEach((cb) => cb());
  }

  async persist() {
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.writeFile(this.manifest, JSON.stringify({ session: this.session, entries: this.entries }, null, 1));
    this.emit();
  }

  /** Démarre (ou continue) une session : une autre session efface la sauvegarde précédente. */
  async begin(session) {
    if (session === this.session) return;
    await this.clear();
    this.session = session;
    await this.persist();
  }

  async clear() {
    await fs.promises.rm(this.dir, { recursive: true, force: true });
    this.session = undefined;
    this.entries = [];
    this.emit();
  }

  has(profileId, remote) {
    return this.entries.some((e) => e.profileId === profileId && e.remote === remote);
  }

  /**
   * Garde la version serveur de `remote` avant qu'elle soit modifiée (sauf si elle est déjà sauvegardée).
   * Les dossiers ne sont pas sauvegardés.
   * @param {import('./clients').RemoteClient} client
   * @param {{ id: string, name: string }} profile
   * @param {string} remote
   */
  async capture(client, profile, remote) {
    if (this.has(profile.id, remote)) return;
    const s = await client.stat(remote);
    if (s?.type === 'dir') return;
    /** @type {BackupEntry} */
    const entry = { profileId: profile.id, profileName: profile.name, remote, existed: !!s };
    if (s) {
      entry.file = `${Date.now().toString(36)}-${this.entries.length}`;
      await client.download(remote, path.join(this.dir, 'files', entry.file));
    }
    this.entries.push(entry);
    await this.persist();
  }

  /**
   * Remet `entry` sur le serveur dans son état sauvegardé.
   * @param {import('./clients').RemoteClient} client
   * @param {BackupEntry} entry
   */
  async restore(client, entry) {
    if (entry.existed && entry.file) {
      await client.mkdirp(path.posix.dirname(entry.remote));
      await client.upload(path.join(this.dir, 'files', entry.file), entry.remote);
    } else if (await client.stat(entry.remote)) {
      await client.deleteFile(entry.remote);
    }
  }

  /** Retire des entrées restaurées (et leurs copies) ; vide la sauvegarde quand il n'en reste plus. */
  async drop(entries) {
    const set = new Set(entries);
    if (!set.size) return;
    for (const e of entries) if (e.file) await fs.promises.rm(path.join(this.dir, 'files', e.file), { force: true });
    this.entries = this.entries.filter((e) => !set.has(e));
    if (this.entries.length) await this.persist();
    else await this.clear();
  }
}

module.exports = { BackupStore };
