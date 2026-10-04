// @ts-check
// Une connexion par profil, réutilisée, avec file d'attente (FTP ne gère qu'une opération à la fois).
const vscode = require('vscode');
const { createClient, AuthError } = require('./clients');

const IDLE_MS = 60_000;

/** Annulation demandée par l'utilisateur (saisie du mot de passe annulée…). */
class CancelledError extends Error {
  constructor() {
    super(vscode.l10n.t('Operation cancelled'));
  }
}

class ConnectionManager {
  /** @param {import('./config').ConfigManager} config @param {vscode.OutputChannel} log */
  constructor(config, log) {
    this.config = config;
    this.log = log;
    /** @type {Map<string, { client?: any, connecting?: Promise<any>, queue: Promise<any>, timer?: NodeJS.Timeout }>} */
    this.pool = new Map();
  }

  /**
   * Exécute `fn(client)` sur la connexion du profil, après les opérations en cours.
   * @template T
   * @param {import('./config').Profile} profile
   * @param {(client: import('./clients').RemoteClient) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  run(profile, fn) {
    const slot = this.slot(profile);
    const task = slot.queue.then(async () => {
      clearTimeout(slot.timer);
      try {
        const client = await this.client(profile, slot);
        try {
          return await fn(client);
        } catch (err) {
          // Connexion tombée entre deux opérations : on reconnecte et on réessaie une fois
          if (!client.closed) throw err;
          this.log.appendLine(`[${profile.name}] connection lost, reconnecting…`);
          return await fn(await this.client(profile, slot));
        }
      } finally {
        slot.timer = setTimeout(() => this.disconnect(profile.id), IDLE_MS);
      }
    });
    slot.queue = task.catch(() => {});
    return task;
  }

  slot(profile) {
    let slot = this.pool.get(profile.id);
    if (!slot) {
      slot = { queue: Promise.resolve() };
      this.pool.set(profile.id, slot);
    }
    return slot;
  }

  async client(profile, slot) {
    if (slot.client && !slot.client.closed) return slot.client;
    slot.client = await this.connect(profile);
    return slot.client;
  }

  /** Connexion avec le mot de passe mémorisé ; s'il est refusé, on le redemande (2 essais). */
  async connect(profile) {
    const useKey = profile.protocol === 'sftp' && (profile.privateKeyPath || profile.agent);
    let password = useKey ? undefined : await this.config.password(profile);
    if (!useKey && password === undefined) throw new CancelledError();
    let passphrase;

    for (let attempt = 0; ; attempt++) {
      const client = createClient({
        protocol: profile.protocol,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        password,
        secure: profile.secure,
        rejectUnauthorized: profile.rejectUnauthorized,
        privateKeyPath: profile.privateKeyPath,
        passphrase,
        agent: profile.agent ? process.env.SSH_AUTH_SOCK : undefined,
        timeout: profile.timeout,
      });
      this.log.appendLine(`[${profile.name}] connecting to ${profile.protocol}://${profile.username}@${profile.host}:${profile.port}`);
      try {
        await client.connect();
        return client;
      } catch (err) {
        const needsPassphrase = /passphrase/i.test(err?.message ?? '');
        if (attempt >= 2 || !(err instanceof AuthError || needsPassphrase)) throw err;
        if (needsPassphrase) {
          passphrase = await vscode.window.showInputBox({ title: vscode.l10n.t('SSH key passphrase'), prompt: profile.privateKeyPath, password: true, ignoreFocusOut: true });
          if (passphrase === undefined) throw new CancelledError();
        } else {
          vscode.window.showWarningMessage(vscode.l10n.t('Password rejected by {0}.', profile.host));
          password = await this.config.password(profile, { forcePrompt: true });
          if (password === undefined) throw new CancelledError();
        }
      }
    }
  }

  disconnect(id) {
    const slot = this.pool.get(id);
    if (!slot) return;
    clearTimeout(slot.timer);
    slot.client?.close();
    slot.client = undefined;
  }

  disconnectAll() {
    for (const id of this.pool.keys()) this.disconnect(id);
  }

  dispose() {
    this.disconnectAll();
  }
}

module.exports = { ConnectionManager, CancelledError };
