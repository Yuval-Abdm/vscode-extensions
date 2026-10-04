// @ts-check
// FileSystemProvider « ftp-sftp-deploy: » : les fichiers du serveur s'ouvrent, s'éditent et s'enregistrent
// directement dans VS Code (et servent de côté gauche pour « Comparer avec le serveur »).
//   ftp-sftp-deploy://<id du profil en hexadécimal>/<chemin distant absolu>
const vscode = require('vscode');
const path = require('path');
const { CancelledError } = require('./connections');

const SCHEME = 'ftp-sftp-deploy';

const toHex = (s) => Buffer.from(s, 'utf8').toString('hex');
const fromHex = (s) => Buffer.from(s, 'hex').toString('utf8');

/** @param {import('./config').Profile} profile @param {string} remotePath */
function remoteUri(profile, remotePath) {
  return vscode.Uri.from({ scheme: SCHEME, authority: toHex(profile.id), path: remotePath });
}

class RemoteFileSystem {
  /** @param {import('./config').ConfigManager} config @param {import('./connections').ConnectionManager} connections */
  constructor(config, connections) {
    this.config = config;
    this.connections = connections;
    this._onDidChangeFile = new vscode.EventEmitter();
    /** @type {vscode.Event<vscode.FileChangeEvent[]>} */
    this.onDidChangeFile = this._onDidChangeFile.event;
  }

  /** @param {vscode.Uri} uri */
  resolve(uri) {
    const profile = this.config.byId(fromHex(uri.authority));
    if (!profile) throw vscode.FileSystemError.Unavailable(vscode.l10n.t('No profile found for {0} (was deploy.json changed?)', uri.toString()));
    return { profile, remotePath: uri.path || '/' };
  }

  /** Exécute une opération distante en traduisant les erreurs pour VS Code. */
  async op(uri, fn) {
    const { profile, remotePath } = this.resolve(uri);
    try {
      return await this.connections.run(profile, (client) => fn(client, remotePath));
    } catch (err) {
      if (err instanceof vscode.FileSystemError) throw err;
      if (err instanceof CancelledError) throw vscode.FileSystemError.Unavailable(vscode.l10n.t('Connection cancelled'));
      throw vscode.FileSystemError.Unavailable(`${profile.host}: ${err?.message ?? err}`);
    }
  }

  fire(...events) {
    this._onDidChangeFile.fire(events);
  }

  watch() {
    return new vscode.Disposable(() => {});
  }

  async stat(uri) {
    const s = await this.op(uri, (c, p) => c.stat(p));
    if (!s) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: s.type === 'dir' ? vscode.FileType.Directory : vscode.FileType.File, ctime: s.mtime, mtime: s.mtime, size: s.size };
  }

  async readDirectory(uri) {
    const entries = await this.op(uri, (c, p) => c.list(p));
    return entries.map((e) => [e.name, e.type === 'dir' ? vscode.FileType.Directory : vscode.FileType.File]);
  }

  async createDirectory(uri) {
    await this.op(uri, (c, p) => c.mkdirp(p));
    this.fire({ type: vscode.FileChangeType.Created, uri });
  }

  async readFile(uri) {
    return new Uint8Array(await this.op(uri, (c, p) => c.read(p)));
  }

  async writeFile(uri, content, options) {
    const existed = await this.op(uri, async (c, p) => {
      const s = await c.stat(p);
      if (s?.type === 'dir') throw vscode.FileSystemError.FileIsADirectory(uri);
      if (!s && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
      if (s && options.create && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
      await c.mkdirp(path.posix.dirname(p));
      await c.write(p, Buffer.from(content));
      return !!s;
    });
    this.fire({ type: existed ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri });
  }

  async delete(uri) {
    await this.op(uri, async (c, p) => {
      const s = await c.stat(p);
      if (!s) throw vscode.FileSystemError.FileNotFound(uri);
      if (s.type === 'dir') await c.deleteDir(p);
      else await c.deleteFile(p);
    });
    this.fire({ type: vscode.FileChangeType.Deleted, uri });
  }

  async rename(oldUri, newUri, options) {
    await this.op(oldUri, async (c, p) => {
      const target = await c.stat(newUri.path);
      if (target && !options.overwrite) throw vscode.FileSystemError.FileExists(newUri);
      await c.rename(p, newUri.path);
    });
    this.fire({ type: vscode.FileChangeType.Deleted, uri: oldUri }, { type: vscode.FileChangeType.Created, uri: newUri });
  }
}

module.exports = { RemoteFileSystem, remoteUri, SCHEME };
