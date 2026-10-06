// Onglet du graphe d'un dépôt : webview, pages de 500 commits placées par GraphLayout, détails du commit sélectionné,
// rechargement quand une référence ou HEAD change.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import type { GitCommands } from '../../git/commands.ts';
import type { GraphRef } from '../../git/parsers/graph.ts';
import type { FileChange } from '../../git/parsers/log.ts';
import type { Repos } from '../../git/repos.ts';
import { absoluteDate, relativeTime } from '../../shared/dates.ts';
import { changeDiffArgs } from '../history/model.ts';
import { errorText } from '../merge/command.ts';
import { GraphLayout, type GraphRow } from './layout.ts';

const PAGE = 500;
const REFRESH_DELAY = 500;

export interface GraphRowData extends GraphRow {
  sha: string;
  parents: string[];
  summary: string;
  author: string;
  authorMail: string;
  date: string;
  refs: GraphRef[];
}

type Incoming =
  | { type: 'ready' }
  | { type: 'loadMore' }
  | { type: 'refresh' }
  | { type: 'setAll'; all: boolean }
  | { type: 'select'; sha: string }
  | { type: 'openFile'; sha: string; index: number };

export class GraphPanel implements vscode.Disposable {
  readonly root: string;
  readonly panel: vscode.WebviewPanel;
  readonly #git: GitCommands;
  readonly #disposables: vscode.Disposable[];
  #layout = new GraphLayout();
  #rows: GraphRowData[] = [];
  #hasMore = false;
  #all = true;
  #loading: Promise<void> | undefined;
  #signature = '';
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #files = new Map<string, FileChange[]>();
  #disposed = false;

  constructor(git: GitCommands, repos: Repos, root: string, extensionUri: vscode.Uri, onDispose: () => void) {
    this.#git = git;
    this.root = root;
    const media = vscode.Uri.joinPath(extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('gitForge.graph', vscode.l10n.t('Graph: {0}', path.basename(root)), vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [media],
    });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    this.panel.webview.html = this.#html(media);
    this.#disposables = [
      this.panel.webview.onDidReceiveMessage((message: Incoming) => this.#receive(message)),
      repos.onDidChange(() => {
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => void this.#reloadIfChanged(), REFRESH_DELAY);
      }),
      this.panel.onDidDispose(() => {
        this.#disposed = true;
        clearTimeout(this.#timer);
        for (const disposable of this.#disposables) disposable.dispose();
        onDispose();
      }),
    ];
  }

  /** Lignes chargées (tests e2e). */
  get rows(): readonly GraphRowData[] {
    return this.#rows;
  }

  get all(): boolean {
    return this.#all;
  }

  dispose(): void {
    this.panel.dispose();
  }

  async reload(): Promise<void> {
    await this.#load(true);
  }

  async #receive(message: Incoming): Promise<void> {
    switch (message.type) {
      case 'ready':
        if (this.#rows.length) this.#post({ type: 'rows', rows: this.#rows, reset: true, hasMore: this.#hasMore, all: this.#all });
        else await this.#load(true);
        break;
      case 'loadMore':
        await this.#load(false);
        break;
      case 'refresh':
        await this.#load(true);
        break;
      case 'setAll':
        this.#all = message.all;
        await this.#load(true);
        break;
      case 'select':
        await this.#details(message.sha);
        break;
      case 'openFile': {
        const row = this.#rows.find((r) => r.sha === message.sha);
        const change = this.#files.get(message.sha)?.[message.index];
        if (row && change) await vscode.commands.executeCommand('gitForge.diffWithPrevious', changeDiffArgs(this.root, row.sha, row.parents[0], change));
        break;
      }
    }
  }

  async #load(reset: boolean): Promise<void> {
    // Un chargement à la fois ; un rechargement complet attend celui en cours.
    while (this.#loading) await this.#loading;
    if (!reset && !this.#hasMore) return;
    this.#loading = (async () => {
      try {
        if (reset) {
          this.#layout = new GraphLayout();
          this.#rows = [];
          this.#files.clear();
          this.#signature = await this.#currentSignature();
        }
        const commits = await this.#git.graph(this.root, { skip: this.#rows.length, limit: PAGE, all: this.#all });
        const placed = this.#layout.add(commits);
        const language = vscode.env.language;
        const now = Date.now();
        const rows = commits.map((commit, i): GraphRowData => ({
          ...placed[i],
          sha: commit.sha,
          parents: commit.parents,
          summary: commit.summary,
          author: commit.author,
          authorMail: commit.authorMail,
          date: relativeTime(commit.authorTime, now, language),
          refs: commit.refs,
        }));
        this.#rows.push(...rows);
        this.#hasMore = commits.length === PAGE;
        this.#post({ type: 'rows', rows, reset, hasMore: this.#hasMore, all: this.#all });
      } catch (err) {
        this.#post({ type: 'error', message: errorText(err) });
      }
    })();
    try {
      await this.#loading;
    } finally {
      this.#loading = undefined;
    }
  }

  async #details(sha: string): Promise<void> {
    const row = this.#rows.find((r) => r.sha === sha);
    if (!row) return;
    try {
      const [files, message] = await Promise.all([
        this.#files.get(sha) ?? this.#git.commitFiles(this.root, sha, row.parents[0]),
        this.#git.message(this.root, sha),
      ]);
      this.#files.set(sha, files);
      this.#post({ type: 'details', sha, message, files, date: absoluteDate(await this.#authorTime(sha), vscode.env.language) });
    } catch (err) {
      this.#post({ type: 'details', sha, message: errorText(err), files: [], date: '' });
    }
  }

  async #authorTime(sha: string): Promise<number> {
    return Number((await this.#git.runner.read(this.root, ['show', '-s', '--format=%at', sha])).stdout.trim());
  }

  /** Références et HEAD : le graphe n'est rechargé que si elles changent. */
  async #currentSignature(): Promise<string> {
    const [refs, head] = await Promise.all([this.#git.refs(this.root), this.#git.revParse(this.root, 'HEAD')]);
    return `${head}|${refs.map((ref) => `${ref.kind}:${ref.name}=${ref.sha}`).join(',')}`;
  }

  async #reloadIfChanged(): Promise<void> {
    if (this.#disposed) return;
    try {
      if ((await this.#currentSignature()) !== this.#signature) await this.#load(true);
    } catch {
      // dépôt en cours de modification : réessayé au prochain changement
    }
  }

  #post(message: unknown): void {
    if (!this.#disposed) void this.panel.webview.postMessage(message);
  }

  #html(media: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, 'graph.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, 'graph.css'));
    const strings = {
      commits: vscode.l10n.t('{0} commits'),
      loading: vscode.l10n.t('Loading…'),
      openDiff: vscode.l10n.t('Double-click to compare with the previous revision'),
      noFiles: vscode.l10n.t('No file changed (merge commit: see the first parent).'),
    };
    const json = JSON.stringify(strings).replace(/</g, '\\u003c');
    const text = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    return `<!DOCTYPE html>
<html lang="${text(vscode.env.language)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style}">
</head>
<body>
<div id="toolbar">
  <input id="search" type="search" placeholder="${text(vscode.l10n.t('Search: message, author, SHA, branch (Enter: next)'))}">
  <label><input id="all" type="checkbox" checked> ${text(vscode.l10n.t('All branches'))}</label>
  <button id="refresh">${text(vscode.l10n.t('Refresh'))}</button>
  <span id="count"></span>
</div>
<div class="row header"><div class="graph"></div><div class="message">${text(vscode.l10n.t('Message'))}</div><div class="author">${text(vscode.l10n.t('Author'))}</div><div class="date">${text(vscode.l10n.t('Date'))}</div><div class="sha">SHA</div></div>
<div id="list"><div id="spacer"></div><div id="rows"></div></div>
<div id="details" hidden></div>
<script id="strings" type="application/json">${json}</script>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
