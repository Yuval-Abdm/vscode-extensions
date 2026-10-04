// @ts-check
const vscode = require('vscode');
const path = require('path');

/** Extension de déploiement optionnelle (boutons nuage, comparer/supprimer sur le serveur). */
const DEPLOY_EXTENSION_ID = 'yuval-abdm.ftp-sftp-deploy';

/** API de FTP SFTP Deploy, ou undefined si elle n'est pas installée. */
async function deployApi() {
  const ext = vscode.extensions.getExtension(DEPLOY_EXTENSION_ID);
  if (!ext) return undefined;
  return ext.isActive ? ext.exports : ext.activate();
}

// Valeurs de l'enum `Status` de l'API git intégrée (extensions/git/src/api/git.d.ts)
const Status = {
  INDEX_MODIFIED: 0,
  INDEX_ADDED: 1,
  INDEX_DELETED: 2,
  INDEX_RENAMED: 3,
  INDEX_COPIED: 4,
  MODIFIED: 5,
  DELETED: 6,
  UNTRACKED: 7,
  IGNORED: 8,
  INTENT_TO_ADD: 9,
  INTENT_TO_RENAME: 10,
  TYPE_CHANGED: 11,
  ADDED_BY_US: 12,
  ADDED_BY_THEM: 13,
  DELETED_BY_US: 14,
  DELETED_BY_THEM: 15,
  BOTH_ADDED: 16,
  BOTH_DELETED: 17,
  BOTH_MODIFIED: 18,
};

const LETTERS = {
  [Status.INDEX_MODIFIED]: 'M',
  [Status.INDEX_ADDED]: 'A',
  [Status.INDEX_DELETED]: 'D',
  [Status.INDEX_RENAMED]: 'R',
  [Status.INDEX_COPIED]: 'C',
  [Status.MODIFIED]: 'M',
  [Status.DELETED]: 'D',
  [Status.UNTRACKED]: 'U',
  [Status.INTENT_TO_ADD]: 'A',
  [Status.INTENT_TO_RENAME]: 'R',
  [Status.TYPE_CHANGED]: 'T',
};

const ADDED = new Set([Status.INDEX_ADDED, Status.UNTRACKED, Status.INTENT_TO_ADD, Status.INDEX_COPIED]);
const DELETED = new Set([Status.INDEX_DELETED, Status.DELETED]);
const CONFLICTS = new Set([
  Status.ADDED_BY_US, Status.ADDED_BY_THEM, Status.DELETED_BY_US, Status.DELETED_BY_THEM,
  Status.BOTH_ADDED, Status.BOTH_DELETED, Status.BOTH_MODIFIED,
]);

/** Catégories affichées, dans l'ordre (libellé traduit à l'affichage via `categoryLabel`). */
const CATEGORIES = [
  { id: 'conflicts', icon: 'warning' },
  { id: 'staged', icon: 'pass' },
  { id: 'unstaged', icon: 'edit' },
  { id: 'untracked', icon: 'question' },
  { id: 'base', icon: 'git-branch' },
];

/** Libellé traduit d'une catégorie. */
function categoryLabel(id) {
  switch (id) {
    case 'conflicts': return vscode.l10n.t('Merge Changes');
    case 'staged': return vscode.l10n.t('Staged Changes');
    case 'unstaged': return vscode.l10n.t('Changes');
    case 'untracked': return vscode.l10n.t('Untracked');
    case 'base': return vscode.l10n.t('Since branch');
    default: return id;
  }
}

/**
 * @typedef {{ uri: vscode.Uri, originalUri: vscode.Uri, status: number }} Change
 * @typedef {{ repo: any, uri: vscode.Uri, originalUri: vscode.Uri, status: number, category: string, ref?: string }} Entry
 * @typedef {{ kind: 'repo', repo: any }
 *   | { kind: 'category', repo: any, category: typeof CATEGORIES[number], entries: Entry[], label: string }
 *   | { kind: 'file', repo: any, entries: Entry[] }} Node
 */

/** @param {Change} change @param {'index'|'working'|'untracked'|'merge'} source */
function categorize(change, source) {
  if (source === 'merge' || CONFLICTS.has(change.status)) return 'conflicts';
  if (change.status === Status.UNTRACKED) return 'untracked';
  if (source === 'index') return 'staged';
  return 'unstaged';
}

function letterOf(status) {
  return CONFLICTS.has(status) ? '!' : LETTERS[status] ?? '?';
}

class ModifiedFilesProvider {
  /** @param {any} git API git */
  constructor(git) {
    this.git = git;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
    /** @type {Map<any, { mergeBase?: string, changes: Change[], error?: string }>} */
    this.baseCache = new Map();
    this.timer = undefined;
    /** @type {(total: number) => void} */
    this.onTotal = () => {};
  }

  get groupByStatus() {
    return vscode.workspace.getConfiguration('changedFiles').get('groupByStatus', true);
  }

  get baseBranch() {
    return vscode.workspace.getConfiguration('changedFiles').get('baseBranch', '').trim();
  }

  /** Rafraîchissement regroupé : les événements git arrivent souvent en rafale. */
  refresh(invalidateBase = true) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (invalidateBase) this.baseCache.clear();
      this._onDidChange.fire(undefined);
    }, 150);
  }

  /** Changements depuis le merge-base avec la branche de base (commits + working tree). */
  async baseChanges(repo) {
    const branch = this.baseBranch;
    if (!branch) return { changes: [] };
    let cached = this.baseCache.get(repo);
    if (!cached) {
      try {
        const head = repo.state.HEAD?.commit ?? 'HEAD';
        const mergeBase = await repo.getMergeBase(branch, head);
        if (!mergeBase) throw new Error(vscode.l10n.t('no common ancestor with {0}', branch));
        const changes = await repo.diffWith(mergeBase);
        cached = { mergeBase, changes };
      } catch (err) {
        cached = { changes: [], error: err?.message ?? String(err) };
      }
      this.baseCache.set(repo, cached);
    }
    return cached;
  }

  /** @returns {Promise<Entry[]>} */
  async entriesOf(repo) {
    const s = repo.state;
    /** @type {Entry[]} */
    const entries = [];
    const push = (list, source) => {
      for (const c of list ?? []) {
        entries.push({ repo, uri: c.uri, originalUri: c.originalUri, status: c.status, category: categorize(c, source) });
      }
    };
    push(s.mergeChanges, 'merge');
    push(s.indexChanges, 'index');
    push(s.workingTreeChanges, 'working');
    push(s.untrackedChanges, 'untracked');

    const base = await this.baseChanges(repo);
    for (const c of base.changes) {
      entries.push({ repo, uri: c.uri, originalUri: c.originalUri, status: c.status, category: 'base', ref: base.mergeBase });
    }
    return entries;
  }

  /** Regroupe les entrées par fichier (un fichier peut être à la fois indexé et modifié). */
  groupByFile(repo, entries) {
    const byPath = new Map();
    for (const e of entries) {
      const key = e.uri.fsPath;
      if (!byPath.has(key)) byPath.set(key, []);
      byPath.get(key).push(e);
    }
    return [...byPath.values()]
      .map((list) => /** @type {Node} */ ({ kind: 'file', repo, entries: list }))
      .sort((a, b) => relPath(a.entries[0]).localeCompare(relPath(b.entries[0])));
  }

  /** @param {Node} [node] */
  async getChildren(node) {
    if (!node) {
      const repos = this.git.repositories;
      if (!repos.length) {
        this.onTotal(0);
        return [];
      }
      if (repos.length === 1) return this.repoChildren(repos[0], true);
      let total = 0;
      const nodes = [];
      for (const repo of repos) {
        const entries = await this.entriesOf(repo);
        total += new Set(entries.map((e) => e.uri.fsPath)).size;
        if (entries.length) nodes.push({ kind: 'repo', repo });
      }
      this.onTotal(total);
      return nodes;
    }
    if (node.kind === 'repo') return this.repoChildren(node.repo, false);
    if (node.kind === 'category') return this.groupByFile(node.repo, node.entries);
    return [];
  }

  async repoChildren(repo, reportTotal) {
    const entries = await this.entriesOf(repo);
    if (reportTotal) this.onTotal(new Set(entries.map((e) => e.uri.fsPath)).size);
    if (!this.groupByStatus) return this.groupByFile(repo, entries);

    const nodes = [];
    for (const category of CATEGORIES) {
      const list = entries.filter((e) => e.category === category.id);
      let label = categoryLabel(category.id);
      if (category.id === 'base') {
        const branch = this.baseBranch;
        if (!branch) continue;
        const { error } = await this.baseChanges(repo);
        label = error
          ? vscode.l10n.t('Since branch {0} — error: {1}', branch, error)
          : vscode.l10n.t('Since branch {0}', branch);
        if (!list.length && !error) continue;
      } else if (!list.length) {
        continue;
      }
      nodes.push({ kind: 'category', repo, category, entries: list, label });
    }
    return nodes;
  }

  /** @param {Node} node */
  getTreeItem(node) {
    if (node.kind === 'repo') {
      const item = new vscode.TreeItem(path.basename(node.repo.rootUri.fsPath), vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('repo');
      item.description = node.repo.state.HEAD?.name ?? '';
      item.tooltip = node.repo.rootUri.fsPath;
      return item;
    }
    if (node.kind === 'category') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(node.category.icon);
      item.description = String(new Set(node.entries.map((e) => e.uri.fsPath)).size);
      item.id = `${node.repo.rootUri.toString()}#${node.category.id}`;
      item.contextValue = 'category';
      return item;
    }

    const entry = node.entries[0];
    const rel = relPath(entry);
    const dir = path.dirname(rel);
    // resourceUri : icône du thème de fichiers + décorations git (couleur, lettre) automatiques
    const item = new vscode.TreeItem(entry.uri, vscode.TreeItemCollapsibleState.None);
    item.label = path.basename(rel);
    const letters = [...new Set(node.entries.map((e) => letterOf(e.status)))].join('');
    item.description = [dir === '.' ? '' : dir, this.groupByStatus ? '' : letters].filter(Boolean).join('  ');
    item.tooltip = `${rel}\n${node.entries.map((e) => `${letterOf(e.status)} · ${categoryLabel(e.category)}`).join('\n')}`;
    // Valeur exacte « file » : l'extension SFTP masque ses entrées « Upload/Download Folder »
    // (inutilisables ici) uniquement pour `viewItem == file`. Les commandes filtrent elles-mêmes
    // les fichiers concernés (existant sur disque, indexé…).
    const exists = existsOnDisk(node);
    item.contextValue = 'file';
    // Comme dans l'Explorateur : un clic ouvre le fichier (le diff reste dans le clic droit)
    item.command = exists
      ? { command: 'vscode.open', title: vscode.l10n.t('Open'), arguments: [entry.uri] }
      : { command: 'changedFiles.openDiff', title: vscode.l10n.t('Open Changes'), arguments: [node] };
    return item;
  }
}

/** @param {Extract<Node, { kind: 'file' }>} node */
function existsOnDisk(node) {
  return !node.entries.some((e) => DELETED.has(e.status));
}

/** @param {Entry} e */
function relPath(e) {
  return path.relative(e.repo.rootUri.fsPath, e.uri.fsPath).split(path.sep).join('/');
}

/**
 * Ouvre le diff le plus pertinent pour un fichier.
 * Quand le fichier apparaît dans plusieurs catégories (vue liste), on montre la modification
 * complète : base de la branche (si comparée) ou HEAD → fichier sur disque.
 * @param {any} git @param {Node} node
 */
async function openDiff(git, node) {
  if (!node || node.kind !== 'file') return;
  const entries = node.entries;
  const pick = entries.length === 1 ? entries[0] : null;
  const e = pick ?? entries.find((x) => x.category === 'conflicts') ?? entries.find((x) => x.category === 'base') ?? entries[0];
  const name = path.basename(e.uri.fsPath);
  const toGit = (uri, ref) => git.toGitUri(uri, ref);

  if (e.category === 'conflicts' || e.status === Status.UNTRACKED || e.status === Status.INTENT_TO_ADD) {
    return vscode.commands.executeCommand('vscode.open', e.uri);
  }

  if (e.category === 'staged' && pick) {
    // HEAD → index
    if (ADDED.has(e.status)) return vscode.commands.executeCommand('vscode.open', toGit(e.uri, ''));
    if (DELETED.has(e.status)) return vscode.commands.executeCommand('vscode.open', toGit(e.uri, 'HEAD'));
    return vscode.commands.executeCommand('vscode.diff', toGit(e.originalUri, 'HEAD'), toGit(e.uri, ''), vscode.l10n.t('{0} (Staged)', name));
  }

  if (e.category === 'unstaged' && pick) {
    // index → fichier sur disque
    if (DELETED.has(e.status)) return vscode.commands.executeCommand('vscode.open', toGit(e.uri, '~'));
    return vscode.commands.executeCommand('vscode.diff', toGit(e.originalUri, '~'), e.uri, vscode.l10n.t('{0} (Working Tree)', name));
  }

  // Modification complète : merge-base ou HEAD → fichier sur disque
  const ref = e.category === 'base' ? e.ref : 'HEAD';
  const label = e.category === 'base' ? vscode.l10n.t('since {0}', ref?.slice(0, 8)) : vscode.l10n.t('since HEAD');
  if (ADDED.has(e.status)) return vscode.commands.executeCommand('vscode.open', e.uri);
  if (entries.some((x) => DELETED.has(x.status))) return vscode.commands.executeCommand('vscode.open', toGit(e.originalUri, ref));
  return vscode.commands.executeCommand('vscode.diff', toGit(e.originalUri, ref), e.uri, `${name} (${label})`);
}

async function selectBaseBranch(git, provider) {
  const repo = git.repositories[0];
  if (!repo) return vscode.window.showWarningMessage(vscode.l10n.t('No git repository open.'));
  const refs = await repo.getBranches({ remote: true, sort: 'committerdate' }).catch(() => []);
  const current = provider.baseBranch;
  const items = [
    { label: `$(close) ${vscode.l10n.t('None')}`, description: vscode.l10n.t('Only show uncommitted changes'), value: '' },
    ...refs
      .filter((r) => r.name && r.name !== repo.state.HEAD?.name && !r.name.endsWith('/HEAD'))
      .map((r) => ({ label: `$(git-branch) ${r.name}`, description: r.name === current ? vscode.l10n.t('current') : '', value: r.name })),
  ];
  const choice = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Compare with which branch?') });
  if (!choice) return;
  await vscode.workspace.getConfiguration('changedFiles').update('baseBranch', choice.value, vscode.ConfigurationTarget.Workspace);
}

/**
 * Actions du clic droit, reprises de l'Explorateur (+ actions git).
 * L'API ne permet pas de réutiliser le menu natif de l'Explorateur dans une vue personnalisée :
 * chaque action est donc réimplémentée ici, en déléguant aux commandes intégrées quand elles acceptent une URI.
 * @param {any} git @param {vscode.TreeView<Node>} view
 */
function registerFileCommands(git, view, provider) {
  /** Fichiers ciblés : multi-sélection, nœud cliqué, ou sélection courante (raccourcis clavier). */
  const targets = (node, nodes) => {
    const list = nodes?.length ? nodes : node ? [node] : view.selection;
    return /** @type {Extract<Node, { kind: 'file' }>[]} */ (list.filter((n) => n?.kind === 'file'));
  };
  /** URIs des fichiers ciblés encore présents sur le disque. */
  const uris = (node, nodes) => targets(node, nodes).filter(existsOnDisk).map((n) => n.entries[0].uri);
  const inCategory = (n, ...cats) => n.entries.some((e) => cats.includes(e.category));
  const exec = (cmd, ...args) => vscode.commands.executeCommand(cmd, ...args);

  /** Applique une opération git, dépôt par dépôt, aux fichiers concernés. */
  const gitOp = async (list, op) => {
    const byRepo = new Map();
    for (const n of list) {
      if (!byRepo.has(n.repo)) byRepo.set(n.repo, []);
      byRepo.get(n.repo).push(n.entries[0].uri.fsPath);
    }
    try {
      for (const [repo, paths] of byRepo) await op(repo, paths);
    } catch (err) {
      vscode.window.showErrorMessage(vscode.l10n.t('Git: {0}', err?.message ?? String(err)));
    }
  };

  const confirm = async (message, action) =>
    (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;


  const commands = {
    openFile: (n, ns) => uris(n, ns).forEach((u) => exec('vscode.open', u)),
    openToSide: (n, ns) => uris(n, ns).forEach((u) => exec('vscode.open', u, { viewColumn: vscode.ViewColumn.Beside, preview: false })),
    openDiff: (n, ns) => targets(n, ns).forEach((t) => openDiff(git, t)),
    revealInOS: (n) => uris(n).slice(0, 1).forEach((u) => exec('revealFileInOS', u)),
    revealInExplorer: (n) => uris(n).slice(0, 1).forEach((u) => exec('revealInExplorer', u)),
    openInTerminal: (n) => uris(n).slice(0, 1).forEach((u) => exec('openInTerminal', u)),
    findInFolder: (n) =>
      uris(n).slice(0, 1).forEach((u) =>
        exec('workbench.action.findInFiles', { filesToInclude: vscode.workspace.asRelativePath(path.dirname(u.fsPath)) })),
    copyPath: (n, ns) => vscode.env.clipboard.writeText(uris(n, ns).map((u) => u.fsPath).join('\n')),
    copyRelativePath: (n, ns) =>
      vscode.env.clipboard.writeText(targets(n, ns).map((t) => relPath(t.entries[0])).join('\n')),

    rename: async (n) => {
      const [uri] = uris(n);
      if (!uri) return;
      const name = path.basename(uri.fsPath);
      const dot = name.lastIndexOf('.');
      const newName = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('New name'),
        value: name,
        valueSelection: [0, dot > 0 ? dot : name.length],
        validateInput: (v) => (!v.trim() ? vscode.l10n.t('The name cannot be empty') : /[\\/]/.test(v) ? vscode.l10n.t('The name cannot contain / or \\') : null),
      });
      if (!newName || newName === name) return;
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(uri, vscode.Uri.joinPath(uri, '..', newName));
      if (!(await vscode.workspace.applyEdit(edit))) vscode.window.showErrorMessage(vscode.l10n.t('Could not rename {0}.', name));
    },

    delete: async (n, ns) => {
      const list = uris(n, ns);
      if (!list.length) return;
      const question = list.length === 1
        ? vscode.l10n.t("Are you sure you want to delete '{0}'?", path.basename(list[0].fsPath))
        : vscode.l10n.t('Are you sure you want to delete these {0} files?', list.length);
      if (!(await confirm(question, vscode.l10n.t('Move to Trash')))) return;
      for (const uri of list) {
        try {
          await vscode.workspace.fs.delete(uri, { useTrash: true });
        } catch {
          if (await confirm(vscode.l10n.t("Trash is unavailable. Permanently delete '{0}'?", path.basename(uri.fsPath)), vscode.l10n.t('Delete Permanently'))) {
            await vscode.workspace.fs.delete(uri, { useTrash: false });
          }
        }
      }
    },

    stage: async (n, ns) => {
      const list = targets(n, ns).filter((t) => inCategory(t, 'unstaged', 'untracked', 'conflicts'));
      if (!list.length) return void vscode.window.showInformationMessage(vscode.l10n.t('Nothing to stage: no unstaged changes.'));
      await gitOp(list, (repo, paths) => repo.add(paths));
    },
    unstage: async (n, ns) => {
      const list = targets(n, ns).filter((t) => inCategory(t, 'staged'));
      if (!list.length) return void vscode.window.showInformationMessage(vscode.l10n.t('Nothing to unstage: no staged files in the selection.'));
      await gitOp(list, (repo, paths) => repo.revert(paths));
    },
    discard: async (n, ns) => {
      const list = targets(n, ns).filter((t) => inCategory(t, 'unstaged', 'untracked'));
      if (!list.length) return void vscode.window.showInformationMessage(vscode.l10n.t('No unstaged changes to discard.'));
      const question = list.length === 1
        ? vscode.l10n.t("Are you sure you want to discard changes in '{0}'?\nThis is irreversible (untracked files will be deleted).", path.basename(list[0].entries[0].uri.fsPath))
        : vscode.l10n.t('Are you sure you want to discard changes in these {0} files?\nThis is irreversible (untracked files will be deleted).', list.length);
      const ok = await confirm(question, vscode.l10n.t('Discard Changes'));
      if (ok) await gitOp(list, (repo, paths) => repo.clean(paths));
    },

    // Déploiement : délégué à l'extension FTP SFTP Deploy si elle est installée
    uploadSelection: (n, ns) => withDeploy((api) => {
      const list = targets(n, ns);
      const skipped = list.length - list.filter(existsOnDisk).length;
      if (skipped) vscode.window.showInformationMessage(vscode.l10n.t("{0} deleted file(s) not uploaded: use 'Delete from server'.", skipped));
      return api.upload(uris(n, ns));
    }),
    deleteRemote: (n, ns) => withDeploy((api) => api.deleteRemote(targets(n, ns).map((t) => t.entries[0].uri))),
    diffWithServer: (n) => withDeploy((api) => targets(n).slice(0, 1).forEach((t) => api.diff(t.entries[0].uri))),
    uploadCategory: (n) => withDeploy((api) => n?.kind === 'category' && syncWithServer(api, fileNodes(n), n.label)),
    uploadAll: () => withDeploy(async (api) => {
      const all = [];
      for (const repo of git.repositories) all.push(...provider.groupByFile(repo, await provider.entriesOf(repo)));
      return syncWithServer(api, all, vscode.l10n.t('all changed files'));
    }),
  };

  /** Exécute `fn(api)` si FTP SFTP Deploy est installée et configurée, sinon guide l'utilisateur. */
  async function withDeploy(fn) {
    const api = await deployApi();
    if (!api) {
      const install = vscode.l10n.t('Install');
      const choice = await vscode.window.showInformationMessage(
        vscode.l10n.t("Deploying requires the 'FTP SFTP Deploy' extension."), install);
      if (choice === install) await exec('workbench.extensions.search', DEPLOY_EXTENSION_ID);
      return;
    }
    if (api.hasConfig()) return fn(api);
    const create = vscode.l10n.t('Create configuration');
    const importSftp = vscode.l10n.t('Import sftp.json');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('No deployment profile: create .vscode/deploy.json.'), create, importSftp);
    if (choice) await exec(choice === create ? 'ftpSftpDeploy.createConfig' : 'ftpSftpDeploy.importSftp');
  }

  /** @param {Extract<Node, { kind: 'category' }>} category */
  function fileNodes(category) {
    const byPath = new Map();
    for (const e of category.entries) {
      if (!byPath.has(e.uri.fsPath)) byPath.set(e.uri.fsPath, { kind: 'file', repo: e.repo, entries: [] });
      byPath.get(e.uri.fsPath).entries.push(e);
    }
    return [...byPath.values()];
  }

  /**
   * Synchronise des fichiers modifiés avec le serveur : upload des fichiers présents,
   * et (au choix) suppression distante des fichiers supprimés ou de l'ancien nom des fichiers renommés.
   * @param {Extract<Node, { kind: 'file' }>[]} list
   */
  async function syncWithServer(api, list, label) {
    const uploads = list.filter(existsOnDisk).map((n) => n.entries[0].uri);
    const deletions = new Map();
    for (const n of list) {
      for (const e of n.entries) {
        if (DELETED.has(e.status)) deletions.set(e.uri.fsPath, e.uri);
        else if (e.originalUri.fsPath !== e.uri.fsPath) deletions.set(e.originalUri.fsPath, e.originalUri); // renommé
      }
    }
    // Un fichier ré-uploadé ne doit pas être supprimé
    for (const u of uploads) deletions.delete(u.fsPath);
    const toUpload = api.resolve(uploads);
    const toDelete = api.resolve([...deletions.values()]);
    if (!toUpload.length && !toDelete.length) return void vscode.window.showInformationMessage(vscode.l10n.t('Nothing to deploy (files excluded or outside the configured folders).'));

    const show = (ts) => ts.slice(0, 12).map((t) => `   ${t.rel}`).join('\n')
      + (ts.length > 12 ? `\n   ${vscode.l10n.t('… and {0} more', ts.length - 12)}` : '');
    const profiles = [...new Set([...toUpload, ...toDelete].map((t) => `${t.profile} (${t.host})`))].join(', ');
    let message = vscode.l10n.t('Deploy {0} to {1}?', label, profiles);
    if (toUpload.length) message += `\n\n${vscode.l10n.t('↑ {0} to upload:', toUpload.length)}\n${show(toUpload)}`;
    if (toDelete.length) message += `\n\n${vscode.l10n.t('✕ {0} to delete from server:', toDelete.length)}\n${show(toDelete)}`;
    // Libellés des boutons gardés en constantes : la réponse est comparée à la valeur traduite
    const UPLOAD = vscode.l10n.t('Upload');
    const UPLOAD_AND_DELETE = vscode.l10n.t('Upload and delete');
    const DELETE_FROM_SERVER = vscode.l10n.t('Delete from server');
    const UPLOAD_ONLY = vscode.l10n.t('Upload only');
    const buttons = toDelete.length
      ? [toUpload.length ? UPLOAD_AND_DELETE : DELETE_FROM_SERVER, ...(toUpload.length ? [UPLOAD_ONLY] : [])]
      : [UPLOAD];
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, ...buttons);
    if (!choice) return;
    if (toUpload.length) await api.upload(toUpload.map((t) => t.uri));
    if (toDelete.length && choice !== UPLOAD_ONLY) await api.deleteRemote(toDelete.map((t) => t.uri), { confirm: false });
  }

  return Object.entries(commands).map(([id, fn]) => vscode.commands.registerCommand(`changedFiles.${id}`, fn));
}

/** @param {vscode.ExtensionContext} context */
async function activate(context) {
  const gitExt = vscode.extensions.getExtension('vscode.git');
  if (!gitExt) return void vscode.window.showErrorMessage(vscode.l10n.t('The built-in Git extension was not found.'));
  const git = (gitExt.isActive ? gitExt.exports : await gitExt.activate()).getAPI(1);

  const provider = new ModifiedFilesProvider(git);
  const view = vscode.window.createTreeView('changedFiles', { treeDataProvider: provider, showCollapseAll: true, canSelectMany: true });
  provider.onTotal = (total) => {
    view.badge = total ? { value: total, tooltip: vscode.l10n.t('{0} changed file(s)', total) } : undefined;
  };

  /** @type {Map<any, vscode.Disposable>} */
  const repoListeners = new Map();
  const watch = (repo) => {
    if (repoListeners.has(repo)) return;
    repoListeners.set(repo, repo.state.onDidChange(() => provider.refresh()));
    provider.refresh();
  };
  git.repositories.forEach(watch);

  const collectAll = async () => {
    const files = new Set();
    for (const repo of git.repositories) {
      for (const e of await provider.entriesOf(repo)) files.add(git.repositories.length > 1 ? e.uri.fsPath : relPath(e));
    }
    return [...files].sort();
  };

  context.subscriptions.push(
    view,
    git.onDidOpenRepository(watch),
    git.onDidCloseRepository((repo) => {
      repoListeners.get(repo)?.dispose();
      repoListeners.delete(repo);
      provider.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('changedFiles')) provider.refresh();
    }),
    vscode.commands.registerCommand('changedFiles.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('changedFiles.toggleGrouping', () =>
      vscode.workspace.getConfiguration('changedFiles').update('groupByStatus', !provider.groupByStatus, vscode.ConfigurationTarget.Global)),
    vscode.commands.registerCommand('changedFiles.selectBaseBranch', () => selectBaseBranch(git, provider)),
    ...registerFileCommands(git, view, provider),
    vscode.commands.registerCommand('changedFiles.copyList', async () => {
      const files = await collectAll();
      await vscode.env.clipboard.writeText(files.join('\n'));
      vscode.window.showInformationMessage(vscode.l10n.t('{0} path(s) copied to the clipboard.', files.length));
    }),
    { dispose: () => repoListeners.forEach((d) => d.dispose()) },
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
