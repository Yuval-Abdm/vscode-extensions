// @ts-check
// Clients FTP/FTPS (basic-ftp) et SFTP (ssh2) derrière une interface commune.
// Tous les chemins distants sont absolus (POSIX). Aucune dépendance à vscode.
const fs = require('fs');
const path = require('path');
const { Readable, Writable } = require('stream');

/**
 * @typedef {'file' | 'dir'} EntryType
 * @typedef {{ name: string, type: EntryType, size: number, mtime: number }} RemoteEntry
 * @typedef {{ type: EntryType, size: number, mtime: number }} RemoteStat
 * @typedef {{
 *   protocol: 'ftp' | 'ftps' | 'sftp', host: string, port?: number, username?: string, password?: string,
 *   secure?: boolean | 'implicit', rejectUnauthorized?: boolean,
 *   privateKeyPath?: string, passphrase?: string, agent?: string, timeout?: number,
 * }} ConnectOptions
 *
 * @typedef {object} RemoteClient
 * @property {() => Promise<void>} connect
 * @property {() => void} close
 * @property {(dir: string) => Promise<RemoteEntry[]>} list
 * @property {(p: string) => Promise<RemoteStat | null>} stat
 * @property {(p: string) => Promise<Buffer>} read
 * @property {(p: string, data: Buffer) => Promise<void>} write
 * @property {(localPath: string, p: string) => Promise<void>} upload
 * @property {(p: string, localPath: string) => Promise<void>} download
 * @property {(dir: string) => Promise<void>} mkdirp
 * @property {(p: string) => Promise<void>} deleteFile
 * @property {(dir: string) => Promise<void>} deleteDir   suppression récursive
 * @property {(from: string, to: string) => Promise<void>} rename
 * @property {(cb: () => void) => void} onClose
 */

/** Erreur d'authentification : déclenche une nouvelle demande de mot de passe. */
class AuthError extends Error {}

const posix = path.posix;

class FtpClient {
  /** @param {ConnectOptions} opts */
  constructor(opts) {
    this.opts = opts;
    const ftp = require('basic-ftp');
    this.client = new ftp.Client(opts.timeout ?? 30000);
    this.closeHandlers = [];
  }

  async connect() {
    const { host, port, username, password, rejectUnauthorized } = this.opts;
    const secure = this.opts.protocol === 'ftps' ? (this.opts.secure === 'implicit' ? 'implicit' : true) : (this.opts.secure ?? false);
    try {
      await this.client.access({
        host, port: port ?? 21, user: username, password, secure,
        secureOptions: { rejectUnauthorized: rejectUnauthorized ?? true },
      });
    } catch (err) {
      this.client.close();
      if (err?.code === 530) throw new AuthError(`Authentication rejected by ${host} (${err.message})`);
      throw err;
    }
    // basic-ftp ne signale pas la fermeture : on la détecte à l'usage (client.closed)
  }

  get closed() {
    return this.client.closed;
  }

  close() {
    this.client.close();
    this.closeHandlers.forEach((cb) => cb());
  }

  onClose(cb) {
    this.closeHandlers.push(cb);
  }

  async list(dir) {
    const items = await this.client.list(dir);
    return items
      .filter((i) => i.name !== '.' && i.name !== '..')
      .map((i) => ({
        name: i.name,
        type: /** @type {EntryType} */ (i.isDirectory ? 'dir' : 'file'),
        size: i.size,
        mtime: i.modifiedAt ? i.modifiedAt.getTime() : 0,
      }));
  }

  async stat(p) {
    if (p === '/') return { type: 'dir', size: 0, mtime: 0 };
    // Pas de STAT portable en FTP : on cherche l'entrée dans la liste du dossier parent
    let entries;
    try {
      entries = await this.list(posix.dirname(p));
    } catch (err) {
      // 450/451/550… selon les serveurs quand le dossier parent n'existe pas
      if (typeof err?.code === 'number' && err.code >= 400) return null; // réponse FTP (pas une erreur réseau)
      throw err;
    }
    const entry = entries.find((e) => e.name === posix.basename(p));
    return entry ? { type: entry.type, size: entry.size, mtime: entry.mtime } : null;
  }

  async read(p) {
    const chunks = [];
    const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
    await this.client.downloadTo(sink, p);
    return Buffer.concat(chunks);
  }

  async write(p, data) {
    await this.client.uploadFrom(Readable.from([data]), p);
  }

  async upload(localPath, p) {
    await this.client.uploadFrom(localPath, p);
  }

  async download(p, localPath) {
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
    await this.client.downloadTo(localPath, p);
  }

  async mkdirp(dir) {
    await this.client.ensureDir(dir); // change aussi le dossier courant : sans effet, on n'utilise que des chemins absolus
  }

  async deleteFile(p) {
    await this.client.remove(p);
  }

  async deleteDir(dir) {
    await this.client.removeDir(dir);
  }

  async rename(from, to) {
    await this.client.rename(from, to);
  }
}

class SftpClient {
  /** @param {ConnectOptions} opts */
  constructor(opts) {
    this.opts = opts;
    this.conn = null;
    /** @type {any} */
    this.sftp = null;
    this.closed = true;
    this.closeHandlers = [];
  }

  async connect() {
    const { Client } = require('ssh2');
    const { host, port, username, password, privateKeyPath, passphrase, agent } = this.opts;
    const conn = new Client();
    const config = {
      host, port: port ?? 22, username, password, agent, passphrase,
      readyTimeout: this.opts.timeout ?? 30000,
      privateKey: privateKeyPath ? await fs.promises.readFile(expandHome(privateKeyPath)) : undefined,
      tryKeyboard: !!password,
    };
    if (password) {
      // Certains serveurs n'acceptent le mot de passe que via keyboard-interactive
      conn.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => finish(prompts.map(() => password)));
    }
    await new Promise((resolve, reject) => {
      conn.once('ready', resolve);
      conn.once('error', (err) => {
        if (err?.level === 'client-authentication') reject(new AuthError(`Authentication rejected by ${host}`));
        else reject(err);
      });
      conn.connect(config);
    });
    this.sftp = await new Promise((resolve, reject) => conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))));
    this.conn = conn;
    this.closed = false;
    conn.on('close', () => {
      this.closed = true;
      this.closeHandlers.forEach((cb) => cb());
    });
    conn.on('error', () => {}); // l'erreur est suivie d'un « close »
  }

  close() {
    this.conn?.end();
    this.closed = true;
  }

  onClose(cb) {
    this.closeHandlers.push(cb);
  }

  /** Appelle une méthode sftp à callback et renvoie une promesse. */
  call(method, ...args) {
    return new Promise((resolve, reject) => this.sftp[method](...args, (err, res) => (err ? reject(err) : resolve(res))));
  }

  async list(dir) {
    const items = await this.call('readdir', dir);
    const entries = [];
    for (const { filename, attrs } of items) {
      if (filename === '.' || filename === '..') continue;
      let type = attrs.isDirectory() ? 'dir' : 'file';
      if (attrs.isSymbolicLink()) {
        const target = await this.stat(posix.join(dir, filename)).catch(() => null);
        type = target?.type ?? 'file';
      }
      entries.push({ name: filename, type: /** @type {EntryType} */ (type), size: attrs.size, mtime: attrs.mtime * 1000 });
    }
    return entries;
  }

  async stat(p) {
    try {
      const s = await this.call('stat', p);
      return { type: s.isDirectory() ? 'dir' : 'file', size: s.size, mtime: s.mtime * 1000 };
    } catch (err) {
      if (err?.code === 2) return null; // NO_SUCH_FILE
      throw err;
    }
  }

  read(p) {
    return this.call('readFile', p);
  }

  async write(p, data) {
    await this.call('writeFile', p, data);
  }

  async upload(localPath, p) {
    await this.call('fastPut', localPath, p);
  }

  async download(p, localPath) {
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
    await this.call('fastGet', p, localPath);
  }

  async mkdirp(dir) {
    const parts = dir.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += '/' + part;
      const s = await this.stat(current);
      if (!s) await this.call('mkdir', current);
      else if (s.type !== 'dir') throw new Error(`${current} already exists and is not a directory`);
    }
  }

  async deleteFile(p) {
    await this.call('unlink', p);
  }

  async deleteDir(dir) {
    for (const entry of await this.list(dir)) {
      const child = posix.join(dir, entry.name);
      if (entry.type === 'dir') await this.deleteDir(child);
      else await this.deleteFile(child);
    }
    await this.call('rmdir', dir);
  }

  async rename(from, to) {
    await this.call('rename', from, to);
  }
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(require('os').homedir(), p.slice(1)) : p;
}

/** @param {ConnectOptions} opts @returns {RemoteClient & { closed: boolean }} */
function createClient(opts) {
  return opts.protocol === 'sftp' ? new SftpClient(opts) : new FtpClient(opts);
}

module.exports = { createClient, FtpClient, SftpClient, AuthError };
