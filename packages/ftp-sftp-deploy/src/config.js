// @ts-check
// Configuration `.vscode/deploy.json` (profils de serveurs) + mots de passe dans le SecretStorage de VS Code.
const vscode = require('vscode');
const path = require('path');
const { DEFAULT_IGNORE, normalizeRemote } = require('./paths');
const { convertSftpConfig } = require('./sftpImport');

const CONFIG_PATH = ['.vscode', 'deploy.json'];
const PROTOCOLS = ['ftp', 'ftps', 'sftp'];

/**
 * @typedef {{
 *   id: string, name: string, folder: vscode.WorkspaceFolder,
 *   protocol: 'ftp' | 'ftps' | 'sftp', host: string, port: number, username: string, remotePath: string,
 *   secure?: boolean | 'implicit', rejectUnauthorized: boolean, privateKeyPath?: string, agent: boolean,
 *   uploadOnSave: boolean, ignore: string[], timeout?: number,
 * }} Profile
 */

/** JSON avec commentaires et virgules finales (comme les fichiers de réglages VS Code). */
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

class ConfigManager {
  /** @param {vscode.ExtensionContext} context @param {vscode.OutputChannel} log */
  constructor(context, log) {
    this.context = context;
    this.log = log;
    /** @type {Map<string, { profiles: Profile[], defaultProfile?: string }>} clé : URI du dossier */
    this.byFolder = new Map();
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;

    const watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/deploy.json');
    const reload = () => this.reload();
    context.subscriptions.push(
      watcher, watcher.onDidChange(reload), watcher.onDidCreate(reload), watcher.onDidDelete(reload),
      vscode.workspace.onDidChangeWorkspaceFolders(reload),
      this._onDidChange,
    );
  }

  configUri(folder) {
    return vscode.Uri.joinPath(folder.uri, ...CONFIG_PATH);
  }

  async reload() {
    // Nouvelle table construite à part puis échangée d'un coup : les profils restent disponibles
    // pendant la relecture, et seul le dernier rechargement lancé est appliqué.
    const seq = (this.reloadSeq = (this.reloadSeq ?? 0) + 1);
    const byFolder = new Map();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      let text;
      try {
        text = new TextDecoder().decode(await vscode.workspace.fs.readFile(this.configUri(folder)));
      } catch {
        continue; // pas de config dans ce dossier
      }
      try {
        byFolder.set(folder.uri.toString(), this.parse(folder, parseJsonc(text)));
      } catch (err) {
        const msg = vscode.l10n.t('Invalid configuration ({0}): {1}', `${folder.name}/.vscode/deploy.json`, err?.message ?? String(err));
        this.log.appendLine(msg);
        vscode.window.showErrorMessage(msg);
      }
    }
    if (seq !== this.reloadSeq) return;
    this.byFolder = byFolder;
    await vscode.commands.executeCommand('setContext', 'ftpSftpDeploy.hasConfig', this.byFolder.size > 0);
    this._onDidChange.fire(undefined);
  }

  /** @param {vscode.WorkspaceFolder} folder @returns {{ profiles: Profile[], defaultProfile?: string }} */
  parse(folder, json) {
    if (!json || typeof json !== 'object' || !json.profiles || typeof json.profiles !== 'object') {
      throw new Error(vscode.l10n.t('the "profiles" key is required'));
    }
    const profiles = Object.entries(json.profiles).map(([name, raw]) => {
      const p = { ...raw };
      const protocol = p.protocol ?? 'ftp';
      if (!PROTOCOLS.includes(protocol)) throw new Error(vscode.l10n.t('profile "{0}": unknown protocol "{1}" (ftp, ftps, sftp)', name, protocol));
      if (!p.host) throw new Error(vscode.l10n.t('profile "{0}": "host" is required', name));
      return /** @type {Profile} */ ({
        id: `${folder.uri.toString()}#${name}`,
        name,
        folder,
        protocol,
        host: p.host,
        port: p.port ?? (protocol === 'sftp' ? 22 : 21),
        username: p.username ?? (protocol === 'sftp' ? '' : 'anonymous'),
        remotePath: normalizeRemote(p.remotePath ?? '/'),
        secure: p.secure,
        rejectUnauthorized: p.rejectUnauthorized ?? json.rejectUnauthorized ?? true,
        privateKeyPath: p.privateKeyPath,
        agent: p.agent ?? false,
        uploadOnSave: p.uploadOnSave ?? json.uploadOnSave ?? false,
        ignore: p.ignore ?? json.ignore ?? DEFAULT_IGNORE,
        timeout: p.timeout ?? json.timeout,
      });
    });
    if (!profiles.length) throw new Error(vscode.l10n.t('no profile defined in "profiles"'));
    return { profiles, defaultProfile: json.defaultProfile };
  }

  /** Tous les profils, éventuellement limités à un dossier. */
  profiles(folder) {
    if (folder) return this.byFolder.get(folder.uri.toString())?.profiles ?? [];
    return [...this.byFolder.values()].flatMap((c) => c.profiles);
  }

  get hasConfig() {
    return this.byFolder.size > 0;
  }

  /** Profil actif d'un dossier : choix mémorisé, sinon `defaultProfile`, sinon le premier. */
  active(folder) {
    const cfg = this.byFolder.get(folder.uri.toString());
    if (!cfg) return undefined;
    const chosen = this.context.workspaceState.get(`activeProfile:${folder.uri.toString()}`);
    return cfg.profiles.find((p) => p.name === chosen)
      ?? cfg.profiles.find((p) => p.name === cfg.defaultProfile)
      ?? cfg.profiles[0];
  }

  async setActive(folder, name) {
    await this.context.workspaceState.update(`activeProfile:${folder.uri.toString()}`, name);
    this._onDidChange.fire(undefined);
  }

  /** Profil actif du dossier contenant `uri`. */
  forUri(uri) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder ? this.active(folder) : undefined;
  }

  byId(id) {
    return this.profiles().find((p) => p.id === id);
  }

  // --- Mots de passe (partagés entre projets utilisant le même compte) ---

  secretKey(profile) {
    return `password:${profile.protocol}://${profile.username}@${profile.host}:${profile.port}`;
  }

  /** Mot de passe mémorisé, sinon demandé (et mémorisé). Undefined si l'utilisateur annule. */
  async password(profile, { forcePrompt = false } = {}) {
    const key = this.secretKey(profile);
    if (!forcePrompt) {
      const stored = await this.context.secrets.get(key);
      if (stored !== undefined) return stored;
    }
    const value = await vscode.window.showInputBox({
      title: vscode.l10n.t('{0} password', profile.protocol.toUpperCase()),
      prompt: vscode.l10n.t('{0} (profile "{1}")', `${profile.username}@${profile.host}`, profile.name),
      password: true,
      ignoreFocusOut: true,
    });
    if (value !== undefined) await this.context.secrets.store(key, value);
    return value;
  }

  async forgetPassword(profile) {
    await this.context.secrets.delete(this.secretKey(profile));
  }

  // --- Création / import ---

  async createTemplate(folder) {
    const uri = this.configUri(folder);
    const template = {
      defaultProfile: 'prod',
      uploadOnSave: false,
      ignore: [...DEFAULT_IGNORE, '*.log'],
      profiles: {
        prod: { protocol: 'ftp', host: 'ftp.example.com', port: 21, username: 'user', remotePath: '/public_html' },
      },
    };
    await this.writeConfig(uri, template);
    await vscode.window.showTextDocument(uri);
  }

  // --- Migration depuis l'extension SFTP (Natizyskunk / liximomo) ---

  /**
   * Convertit `<root>/.vscode/sftp.json` en `<root>/.vscode/deploy.json` et range les mots de passe
   * dans le coffre sécurisé. Ne modifie pas sftp.json. `root` peut être n'importe quel dossier (ouvert ou non).
   * @param {vscode.Uri} root
   * @returns {Promise<{ status: 'migrated' | 'exists' | 'error', profiles: number, passwords: number, warnings: string[], error?: string }>}
   */
  async migrate(root, { overwrite = false } = {}) {
    const target = vscode.Uri.joinPath(root, ...CONFIG_PATH);
    const result = { status: /** @type {'migrated' | 'exists' | 'error'} */ ('migrated'), profiles: 0, passwords: 0, warnings: [] };
    if (!overwrite && (await exists(target))) return { ...result, status: 'exists' };
    try {
      const raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, '.vscode', 'sftp.json')));
      const { config, secrets, warnings } = convertSftpConfig(parseJsonc(raw), vscode.l10n.t);
      if (!Object.keys(config.profiles).length) throw new Error(warnings[0] ?? vscode.l10n.t('no usable profile'));
      for (const { profile, password } of secrets) await this.context.secrets.store(this.secretKey(profile), password);
      await this.writeConfig(target, config);
      this.log.appendLine(`Migration ${root.fsPath}: ${Object.keys(config.profiles).length} profile(s)${warnings.length ? ` — ${warnings.join('; ')}` : ''}`);
      return { ...result, profiles: Object.keys(config.profiles).length, passwords: secrets.length, warnings };
    } catch (err) {
      const error = err?.message ?? String(err);
      this.log.appendLine(`Migration ${root.fsPath}: FAILED — ${error}`);
      return { ...result, status: 'error', error };
    }
  }

  /** Migration du dossier ouvert (commande « Importer depuis sftp.json »). */
  async importSftpJson(folder) {
    let overwrite = false;
    if (await exists(this.configUri(folder))) {
      const replace = vscode.l10n.t('Replace');
      const ok = await vscode.window.showWarningMessage(vscode.l10n.t('{0} already exists. Replace it?', `${folder.name}/.vscode/deploy.json`), { modal: true }, replace);
      if (ok !== replace) return;
      overwrite = true;
    }
    const r = await this.migrate(folder.uri, { overwrite });
    if (r.status === 'error') return void vscode.window.showErrorMessage(vscode.l10n.t('Could not migrate {0}: {1}', `${folder.name}/.vscode/sftp.json`, r.error));
    await this.reload();
    await vscode.window.showTextDocument(this.configUri(folder));
    if (r.warnings.length) vscode.window.showWarningMessage(vscode.l10n.t('Migration of {0}: {1}', folder.name, r.warnings.join('; ')));
    await this.offerSftpDeletion([folder.uri], r.passwords
      ? vscode.l10n.t('{0} profile(s) imported, {1} password(s) saved in secret storage.', r.profiles, r.passwords)
      : vscode.l10n.t('{0} profile(s) imported.', r.profiles));
  }

  /**
   * Propose de supprimer les sftp.json migrés (ils contiennent souvent le mot de passe en clair).
   * @param {vscode.Uri[]} roots dossiers de projet
   * @param {string} summary résultat de la migration, affiché en tête
   */
  async offerSftpDeletion(roots, summary) {
    if (!roots.length) return;
    const question = roots.length === 1
      ? vscode.l10n.t('Delete .vscode/sftp.json? It is no longer needed and usually contains the password in plain text. (Moved to the trash when possible.)')
      : vscode.l10n.t('Delete the {0} migrated .vscode/sftp.json files? They are no longer needed and usually contain the password in plain text. (Moved to the trash when possible.)', roots.length);
    const del = vscode.l10n.t('Delete sftp.json');
    const choice = await vscode.window.showWarningMessage(`${summary}\n\n${question}`, { modal: true }, del, vscode.l10n.t('Keep'));
    if (choice !== del) return;
    let deleted = 0;
    const failed = [];
    for (const root of roots) {
      const file = vscode.Uri.joinPath(root, '.vscode', 'sftp.json');
      try {
        await vscode.workspace.fs.delete(file, { useTrash: true });
        deleted++;
      } catch {
        try {
          await vscode.workspace.fs.delete(file, { useTrash: false }); // corbeille indisponible (WSL, distant…)
          deleted++;
        } catch (err) {
          failed.push(`${file.fsPath}: ${err?.message ?? err}`);
        }
      }
    }
    this.log.appendLine(`Deleting sftp.json: ${deleted} deleted${failed.length ? `, failures: ${failed.join('; ')}` : ''}`);
    if (failed.length) vscode.window.showErrorMessage(vscode.l10n.t('{0} sftp.json file(s) could not be deleted: {1}', failed.length, failed[0]));
    else vscode.window.showInformationMessage(vscode.l10n.t('{0} sftp.json file(s) deleted.', deleted));
  }

  /**
   * Cherche les projets contenant `.vscode/sftp.json` sous `root` (dossiers lourds ignorés).
   * @param {vscode.Uri} root @returns {Promise<vscode.Uri[]>}
   */
  async findSftpProjects(root, maxDepth = 6) {
    const SKIP = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.cache', '.vscode-test']);
    const found = [];
    const walk = async (dir, depth) => {
      let entries;
      try {
        entries = await vscode.workspace.fs.readDirectory(dir);
      } catch {
        return;
      }
      if (entries.some(([n, t]) => n === '.vscode' && t === vscode.FileType.Directory)
        && (await exists(vscode.Uri.joinPath(dir, '.vscode', 'sftp.json')))) {
        found.push(dir);
      }
      if (depth >= maxDepth) return;
      for (const [name, type] of entries) {
        if (type === vscode.FileType.Directory && !SKIP.has(name) && name !== '.vscode') await walk(vscode.Uri.joinPath(dir, name), depth + 1);
      }
    };
    await walk(root, 0);
    return found.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  }

  /** Migration en lot : choix d'un dossier racine, sélection des projets, rapport. */
  async migrateMany() {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      openLabel: vscode.l10n.t('Search for sftp.json here'),
      title: vscode.l10n.t('Folder containing your projects (recursive search for .vscode/sftp.json)'),
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    if (!picked?.[0]) return;
    // Sélectionner directement le dossier « .vscode » d'un projet revient à choisir ce projet
    const root = path.posix.basename(picked[0].path) === '.vscode' ? vscode.Uri.joinPath(picked[0], '..') : picked[0];
    const projects = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Searching for sftp.json in {0}…', root.fsPath) },
      () => this.findSftpProjects(root),
    );
    if (!projects.length) return void vscode.window.showInformationMessage(vscode.l10n.t('No .vscode/sftp.json found under {0}.', root.fsPath));

    const items = [];
    for (const uri of projects) {
      const migrated = await exists(vscode.Uri.joinPath(uri, ...CONFIG_PATH));
      const rel = uri.fsPath === root.fsPath ? path.basename(uri.fsPath) : uri.fsPath.slice(root.fsPath.length + 1);
      items.push({ label: rel, description: migrated ? vscode.l10n.t('deploy.json already exists (will be replaced)') : '', picked: !migrated, uri, migrated });
    }
    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: vscode.l10n.t('{0} project(s) with sftp.json — check the ones to migrate', projects.length),
      placeHolder: vscode.l10n.t('Passwords go to VS Code secret storage; you will be offered to delete sftp.json afterwards'),
    });
    if (!chosen?.length) return;

    const results = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Migrating SFTP configurations') },
      async (progress) => {
        const out = [];
        for (const item of chosen) {
          progress.report({ message: item.label, increment: 100 / chosen.length });
          out.push({ item, r: await this.migrate(item.uri, { overwrite: item.migrated }) });
        }
        return out;
      },
    );
    await this.reload();

    const ok = results.filter((x) => x.r.status === 'migrated');
    const failed = results.filter((x) => x.r.status === 'error');
    const warned = ok.filter((x) => x.r.warnings.length);
    const passwords = ok.reduce((n, x) => n + x.r.passwords, 0);
    this.log.appendLine(`Bulk migration: ${ok.length} succeeded, ${failed.length} failed`);
    for (const x of failed) this.log.appendLine(`  ✖ ${x.item.label}: ${x.r.error}`);
    for (const x of warned) this.log.appendLine(`  ⚠ ${x.item.label}: ${x.r.warnings.join('; ')}`);
    const message = vscode.l10n.t('{0} project(s) migrated, {1} password(s) saved in secret storage.', ok.length, passwords)
      + (failed.length ? ' ' + vscode.l10n.t('{0} failure(s).', failed.length) : '')
      + (warned.length ? ' ' + vscode.l10n.t('{0} warning(s).', warned.length) : '');
    if (failed.length || warned.length) {
      vscode.window.showWarningMessage(message, vscode.l10n.t('Show details')).then((choice) => choice && this.log.show());
    }
    // Seuls les projets migrés avec succès sont proposés à la suppression
    await this.offerSftpDeletion(ok.map((x) => x.item.uri), message);
  }

  /** Propose la migration des dossiers ouverts qui ont un sftp.json mais pas encore de deploy.json. */
  async offerMigration() {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const key = `migrationDismissed:${folder.uri.toString()}`;
      if (this.context.globalState.get(key) || this.byFolder.has(folder.uri.toString())) continue;
      if (!(await exists(vscode.Uri.joinPath(folder.uri, '.vscode', 'sftp.json')))) continue;
      const migrate = vscode.l10n.t('Migrate');
      const migrateAll = vscode.l10n.t('Migrate all my projects…');
      const never = vscode.l10n.t("Don't ask again");
      const choice = await vscode.window.showInformationMessage(
        vscode.l10n.t('SFTP extension configuration found in "{0}". Migrate it to FTP SFTP Deploy?', folder.name),
        migrate, migrateAll, never,
      );
      if (choice === migrate) await this.importSftpJson(folder);
      else if (choice === migrateAll) await this.migrateMany();
      else if (choice === never) await this.context.globalState.update(key, true);
    }
  }

  async writeConfig(uri, json) {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(json, null, 2) + '\n'));
  }
}

async function exists(uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

module.exports = { ConfigManager, parseJsonc };
