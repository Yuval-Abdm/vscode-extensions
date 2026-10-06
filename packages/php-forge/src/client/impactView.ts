// Vue « Impact » (§5.9) : fichiers PHP modifiés (git, documents non enregistrés) et, pour chacun, les pages qui
// l'atteignent par inclusion. « Deploy changed files » envoie les fichiers modifiés par FTP SFTP Deploy (si elle est
// installée), après un avertissement si certains ont des erreurs.
import * as vscode from 'vscode';
import type { ImpactEntry } from '../shared/protocol.ts';
import { changedFiles, conflictedFiles, deploySummary, errorSummary, gitApiOf, isPhp, type DeployTarget, type GitExtension, type GitState } from './changes.ts';

const DEPLOY_EXTENSION_ID = 'yuval-abdm.ftp-sftp-deploy';

/** API publique de FTP SFTP Deploy (version 1) : ce qui est utilisé ici. */
interface DeployApi {
  hasConfig(): boolean;
  /** Fichiers → cibles du profil actif (hors exclusions) */
  resolve(uris: vscode.Uri[]): (DeployTarget & { uri: vscode.Uri })[];
  upload(uris: vscode.Uri[]): Promise<unknown>;
}

interface GitApi {
  repositories: { state: GitState & { onDidChange: vscode.Event<void> } }[];
  onDidOpenRepository: vscode.Event<{ state: GitState & { onDidChange: vscode.Event<void> } }>;
}

type Node = { kind: 'file'; entry: ImpactEntry } | { kind: 'page'; uri: string; label: string } | { kind: 'note'; label: string };

export async function deployApi(): Promise<DeployApi | undefined> {
  const ext = vscode.extensions.getExtension<DeployApi>(DEPLOY_EXTENSION_ID);
  if (!ext) return undefined;
  return ext.isActive ? ext.exports : ext.activate();
}

async function gitApi(): Promise<GitApi | undefined> {
  return gitApiOf(vscode.extensions.getExtension('vscode.git') as GitExtension<GitApi> | undefined);
}

export class ImpactProvider implements vscode.TreeDataProvider<Node> {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.#changed.event;
  readonly #impact: (uris: string[]) => Promise<ImpactEntry[]>;
  #entries: ImpactEntry[] = [];
  #git?: GitApi;
  /** Documents non enregistrés au dernier calcul */
  #dirty = new Set<string>();
  #timer?: ReturnType<typeof setTimeout>;
  onTotal?: (total: number) => void;

  constructor(impact: (uris: string[]) => Promise<ImpactEntry[]>) {
    this.#impact = impact;
  }

  /** Branche la vue sur l'API git et les documents ; renvoie de quoi se débrancher. */
  async start(): Promise<vscode.Disposable[]> {
    this.#git = await gitApi();
    const out: vscode.Disposable[] = [
      vscode.workspace.onDidSaveTextDocument(() => this.refresh()),
      // Document qui devient modifié (ou revient à son contenu enregistré) : pas à chaque frappe
      vscode.workspace.onDidChangeTextDocument((e) => {
        const uri = e.document.uri.toString();
        if (e.document.uri.scheme === 'file' && e.document.isDirty !== this.#dirty.has(uri)) this.refresh();
      }),
    ];
    for (const repo of this.#git?.repositories ?? []) out.push(repo.state.onDidChange(() => this.refresh()));
    if (this.#git) out.push(this.#git.onDidOpenRepository((repo) => {
      out.push(repo.state.onDidChange(() => this.refresh()));
      this.refresh();
    }));
    this.refresh();
    return out;
  }

  /** Fichiers en conflit de fusion des dépôts */
  conflicts(): string[] {
    return conflictedFiles((this.#git?.repositories ?? []).map((r) => r.state));
  }

  /** Fichiers modifiés de tous les dépôts et documents non enregistrés (tous types). */
  changed(): string[] {
    const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file').map((d) => d.uri.toString());
    this.#dirty = new Set(dirty);
    return changedFiles((this.#git?.repositories ?? []).map((r) => r.state), dirty);
  }

  /** Recalcul groupé (les événements git arrivent en rafale). */
  refresh(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#update(), 300);
  }

  async #update(): Promise<void> {
    try {
      this.#entries = await this.#impact(this.changed().filter(isPhp));
    } catch {
      this.#entries = [];
    }
    this.onTotal?.(this.#entries.length);
    this.#changed.fire();
  }

  get entries(): ImpactEntry[] {
    return this.#entries;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'note') return new vscode.TreeItem(node.label);
    if (node.kind === 'page') {
      const item = new vscode.TreeItem(node.label);
      item.resourceUri = vscode.Uri.parse(node.uri);
      item.command = { title: vscode.l10n.t('Open'), command: 'vscode.open', arguments: [item.resourceUri] };
      return item;
    }
    const { entry } = node;
    const item = new vscode.TreeItem(entry.label, vscode.TreeItemCollapsibleState.Collapsed);
    item.resourceUri = vscode.Uri.parse(entry.uri);
    const self = entry.pages.length === 1 && entry.pages[0].uri === entry.uri;
    item.description = self ? vscode.l10n.t('page') : entry.pages.length === 1 ? vscode.l10n.t('1 page') : vscode.l10n.t('{0} pages', entry.pages.length);
    if (entry.approximate) item.tooltip = vscode.l10n.t('Included through a dynamic path: some pages may be missing');
    item.contextValue = 'changedFile';
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.#entries.map((entry) => ({ kind: 'file', entry }));
    if (node.kind !== 'file') return [];
    const pages: Node[] = node.entry.pages.map((p) => ({ kind: 'page', uri: p.uri, label: p.label }));
    if (node.entry.approximate) pages.push({ kind: 'note', label: vscode.l10n.t('(included through a dynamic path: some pages may be missing)') });
    return pages;
  }
}

/**
 * « Deploy changed files » : enregistrer, avertir des erreurs, confirmer (fichiers et serveur), envoyer par FTP SFTP
 * Deploy. Les fichiers en conflit de fusion ne sont jamais envoyés.
 */
export async function deployChanged(provider: ImpactProvider): Promise<void> {
  const api = await deployApi();
  if (!api) {
    const install = vscode.l10n.t('Install FTP SFTP Deploy');
    if ((await vscode.window.showInformationMessage(vscode.l10n.t('Deploying needs the FTP SFTP Deploy extension.'), install)) === install) {
      await vscode.commands.executeCommand('workbench.extensions.search', DEPLOY_EXTENSION_ID);
    }
    return;
  }
  if (!api.hasConfig()) {
    void vscode.window.showWarningMessage(vscode.l10n.t('No FTP SFTP Deploy profile in this workspace: create .vscode/deploy.json first.'));
    return;
  }
  const conflicts = new Set(provider.conflicts());
  const uris = provider.changed().filter((u) => !conflicts.has(u)).map((u) => vscode.Uri.parse(u));
  if (!uris.length) {
    void vscode.window.showInformationMessage(vscode.l10n.t('No changed file to deploy.'));
    return;
  }
  const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && uris.some((u) => u.toString() === d.uri.toString()));
  if (dirty.length) {
    const save = vscode.l10n.t('Save and deploy');
    const names = dirty.map((d) => vscode.workspace.asRelativePath(d.uri)).join(', ');
    if ((await vscode.window.showWarningMessage(vscode.l10n.t('{0} changed files are not saved: {1}', dirty.length, names), { modal: true }, save)) !== save) return;
    for (const doc of dirty) {
      // Enregistrement refusé : la version du disque partirait sur le serveur
      if (!(await doc.save())) {
        void vscode.window.showErrorMessage(vscode.l10n.t('{0} could not be saved: nothing was deployed.', vscode.workspace.asRelativePath(doc.uri)));
        return;
      }
    }
  }
  if (vscode.workspace.getConfiguration('phpForge').get<boolean>('deploy.checkErrors', true)) {
    const summary = errorSummary(uris.map((uri) => ({
      label: vscode.workspace.asRelativePath(uri),
      errors: vscode.languages.getDiagnostics(uri).filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length,
    })));
    if (summary) {
      const deploy = vscode.l10n.t('Deploy anyway');
      const choice = await vscode.window.showWarningMessage(vscode.l10n.t('{0} files to deploy have errors: {1}', summary.count, summary.names), { modal: true }, deploy);
      if (choice !== deploy) return;
    }
  }
  // Ce qui part vraiment (profil, exclusions) : nombre, serveur et chemins à confirmer
  const targets = api.resolve(uris);
  if (!targets.length) {
    void vscode.window.showInformationMessage(vscode.l10n.t('None of the changed files belongs to a deploy profile.'));
    return;
  }
  const summary = deploySummary(targets);
  const lines = [...summary.paths, ...(summary.more ? [vscode.l10n.t('… and {0} more', summary.more)] : [])];
  if (conflicts.size) lines.push('', vscode.l10n.t('{0} files in merge conflict are not deployed.', conflicts.size));
  const deploy = vscode.l10n.t('Deploy');
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t('Upload {0} changed files to {1}?', summary.count, summary.servers.join(', ')),
    { modal: true, detail: lines.join('\n') },
    deploy,
  );
  if (choice !== deploy) return;
  await api.upload(targets.map((t) => t.uri));
}
