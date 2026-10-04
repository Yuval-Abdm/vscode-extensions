// @ts-check
// Opérations de déploiement sur des fichiers locaux : upload, suppression distante, téléchargement, comparaison.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { relativeLocal, toRemote, relativeRemote, isIgnored } = require('./paths');
const { remoteUri } = require('./remoteFs');
const { CancelledError } = require('./connections');

// Libellés de boutons (comparés à la réponse de l'utilisateur)
const DELETE_FROM_SERVER = () => vscode.l10n.t('Delete from server');
const DOWNLOAD = () => vscode.l10n.t('Download');

/**
 * @typedef {import('./config').Profile} Profile
 * @typedef {{ uri: vscode.Uri, profile: Profile, rel: string, remote: string }} Target
 */

class Deployer {
  /**
   * @param {import('./config').ConfigManager} config
   * @param {import('./connections').ConnectionManager} connections
   * @param {import('./remoteFs').RemoteFileSystem} remoteFs
   * @param {vscode.OutputChannel} log
   */
  constructor(config, connections, remoteFs, log) {
    this.config = config;
    this.connections = connections;
    this.remoteFs = remoteFs;
    this.log = log;
  }

  /**
   * Associe chaque URI locale à son profil actif et à son chemin distant.
   * @param {vscode.Uri[]} uris
   * @returns {{ targets: Target[], ignored: number, outside: number }}
   */
  resolve(uris) {
    const targets = [];
    let ignored = 0;
    let outside = 0;
    for (const uri of uris) {
      const profile = this.config.forUri(uri);
      const rel = profile && relativeLocal(profile.folder.uri.fsPath, uri.fsPath);
      if (!profile || rel === null || rel === undefined) outside++;
      else if (isIgnored(rel, profile.ignore)) ignored++;
      else targets.push({ uri, profile, rel, remote: toRemote(profile.remotePath, rel) });
    }
    return { targets, ignored, outside };
  }

  /** Développe les dossiers en la liste de leurs fichiers (en sautant les dossiers exclus). */
  async expandLocal(uris) {
    const files = [];
    const walk = async (fsPath) => {
      const uri = vscode.Uri.file(fsPath);
      const profile = this.config.forUri(uri);
      const rel = profile && relativeLocal(profile.folder.uri.fsPath, fsPath);
      if (profile && rel && isIgnored(rel, profile.ignore)) return;
      const st = await fs.promises.stat(fsPath).catch(() => null);
      if (!st) return;
      if (st.isDirectory()) {
        for (const name of await fs.promises.readdir(fsPath)) await walk(path.join(fsPath, name));
      } else {
        files.push(uri);
      }
    };
    for (const uri of uris) await walk(uri.fsPath);
    return files;
  }

  /**
   * Exécute `action` sur chaque cible avec une notification de progression annulable.
   * @param {string} title
   * @param {Target[]} targets
   * @param {(client: import('./clients').RemoteClient, t: Target, ctx: { dirs: Set<string> }) => Promise<void>} action
   * @param {{ silent?: boolean }} [opts] silent : pas de notification, juste la barre d'état
   */
  async batch(title, targets, action, { silent = false } = {}) {
    if (!targets.length) return { done: 0, failed: [] };
    const failed = [];
    let done = 0;
    const ctx = { dirs: new Set() };
    const work = async (progress, token) => {
      for (const t of targets) {
        if (token?.isCancellationRequested) break;
        progress?.report({ message: t.rel, increment: 100 / targets.length });
        try {
          await this.connections.run(t.profile, (client) => action(client, t, ctx));
          done++;
          this.log.appendLine(`[${t.profile.name}] ${title}: ${t.rel} → ${t.remote}`);
        } catch (err) {
          if (err instanceof CancelledError) break;
          failed.push({ target: t, error: err?.message ?? String(err) });
          this.log.appendLine(`[${t.profile.name}] FAILED ${title}: ${t.rel} — ${err?.message ?? err}`);
        }
      }
    };
    if (silent) {
      const status = vscode.window.setStatusBarMessage(`$(sync~spin) ${title}…`);
      try {
        await work(undefined, undefined);
      } finally {
        status.dispose();
      }
    } else {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, work);
    }
    this.report(title, targets, done, failed, silent);
    return { done, failed };
  }

  report(title, targets, done, failed, silent) {
    const hosts = [...new Set(targets.map((t) => t.profile.name))].join(', ');
    if (failed.length) {
      const detail = failed.slice(0, 3).map((f) => `${f.target.rel}: ${f.error}`).join(' · ');
      vscode.window.showErrorMessage(vscode.l10n.t('{0}: {1} of {2} failed. {3}', title, failed.length, targets.length, detail), vscode.l10n.t('Show logs'))
        .then((choice) => choice && this.log.show());
    } else if (silent) {
      vscode.window.setStatusBarMessage(`$(check) ${vscode.l10n.t('{0}: {1} file(s) → {2}', title, done, hosts)}`, 5000);
    } else {
      vscode.window.showInformationMessage(vscode.l10n.t('{0}: {1} file(s) → {2}', title, done, hosts));
    }
  }

  /** Upload de fichiers et/ou dossiers locaux, chacun à son emplacement relatif sur le serveur. */
  async upload(uris, { silent = false } = {}) {
    const files = await this.expandLocal(uris);
    const { targets, ignored, outside } = this.resolve(files);
    this.warnSkipped(ignored, outside, silent, targets.length);
    return this.batch(vscode.l10n.t('Upload'), targets, async (client, t, ctx) => {
      const dir = path.posix.dirname(t.remote);
      if (!ctx.dirs.has(dir)) {
        await client.mkdirp(dir);
        ctx.dirs.add(dir);
      }
      await client.upload(t.uri.fsPath, t.remote);
      this.remoteFs.fire({ type: vscode.FileChangeType.Changed, uri: remoteUri(t.profile, t.remote) });
    }, { silent });
  }

  /** Supprime sur le serveur les fichiers/dossiers correspondant à ces chemins locaux (qui peuvent ne plus exister). */
  async deleteRemote(uris, { confirm = true } = {}) {
    const { targets } = this.resolve(uris);
    if (!targets.length) return { done: 0, failed: [] };
    if (confirm) {
      const list = targets.slice(0, 15).map((t) => t.remote).join('\n') + (targets.length > 15 ? '\n' + vscode.l10n.t('… and {0} more', targets.length - 15) : '');
      const ok = await vscode.window.showWarningMessage(
        vscode.l10n.t('Permanently delete {0} item(s) from the server ({1})?', targets.length, targets[0].profile.name)
          + `\n\n${list}\n\n` + vscode.l10n.t('This cannot be undone.'),
        { modal: true }, DELETE_FROM_SERVER());
      if (ok !== DELETE_FROM_SERVER()) return { done: 0, failed: [] };
    }
    return this.batch(vscode.l10n.t('Remote delete'), targets, async (client, t) => {
      const s = await client.stat(t.remote);
      if (!s) return; // déjà absent : rien à faire
      if (s.type === 'dir') await client.deleteDir(t.remote);
      else await client.deleteFile(t.remote);
      this.remoteFs.fire({ type: vscode.FileChangeType.Deleted, uri: remoteUri(t.profile, t.remote) });
    });
  }

  /** Télécharge des fichiers/dossiers distants vers leur emplacement local (remplace les fichiers locaux). */
  async download(uris) {
    const { targets: roots } = this.resolve(uris);
    if (!roots.length) return;
    const ok = await vscode.window.showWarningMessage(
      roots.length === 1
        ? vscode.l10n.t('Download from the server and replace "{0}" locally?', roots[0].rel || '.')
        : vscode.l10n.t('Download from the server and replace {0} items locally?', roots.length),
      { modal: true }, DOWNLOAD());
    if (ok !== DOWNLOAD()) return;

    // Développe les dossiers distants en la liste de leurs fichiers
    const targets = [];
    try {
      for (const root of roots) {
        await this.connections.run(root.profile, async (client) => {
          const walk = async (remote, rel) => {
            if (isIgnored(rel, root.profile.ignore)) return;
            const s = await client.stat(remote);
            if (!s) throw new Error(vscode.l10n.t('{0} does not exist on the server', remote));
            if (s.type === 'file') {
              targets.push({ ...root, rel, remote, uri: vscode.Uri.joinPath(root.profile.folder.uri, ...rel.split('/')) });
              return;
            }
            for (const e of await client.list(remote)) await walk(path.posix.join(remote, e.name), rel ? `${rel}/${e.name}` : e.name);
          };
          await walk(root.remote, root.rel);
        });
      }
    } catch (err) {
      if (!(err instanceof CancelledError)) vscode.window.showErrorMessage(`${vscode.l10n.t('Download')}: ${err?.message ?? err}`);
      return;
    }
    return this.batch(vscode.l10n.t('Download'), targets, (client, t) => client.download(t.remote, t.uri.fsPath));
  }

  /** Ouvre un diff « serveur ↔ local » pour un fichier. */
  async diff(uri) {
    const { targets, ignored, outside } = this.resolve([uri]);
    const t = targets[0];
    if (!t) {
      return void vscode.window.showWarningMessage(outside
        ? vscode.l10n.t('This file is not covered by any deployment profile.')
        : ignored ? vscode.l10n.t('This file is excluded ("ignore").') : vscode.l10n.t('File not found.'));
    }
    const left = remoteUri(t.profile, t.remote);
    await vscode.commands.executeCommand('vscode.diff', left, uri, `${path.basename(t.rel)} (${t.profile.name} ↔ local)`);
  }

  /** Fichier local correspondant à un chemin distant, ou undefined s'il est hors de remotePath. */
  localFor(profile, remotePath) {
    const rel = relativeRemote(profile.remotePath, remotePath);
    if (rel === null) return undefined;
    return rel ? vscode.Uri.joinPath(profile.folder.uri, ...rel.split('/')) : profile.folder.uri;
  }

  warnSkipped(ignored, outside, silent, kept) {
    if (silent || (!ignored && !outside)) return;
    const parts = [];
    if (ignored) parts.push(vscode.l10n.t('{0} excluded by "ignore"', ignored));
    if (outside) parts.push(vscode.l10n.t('{0} outside a configured folder', outside));
    if (!kept) vscode.window.showWarningMessage(vscode.l10n.t('Nothing to upload: {0}.', parts.join(', ')));
    else vscode.window.setStatusBarMessage(`$(info) ${vscode.l10n.t('Skipped: {0}', parts.join(', '))}`, 8000);
  }
}

module.exports = { Deployer };
