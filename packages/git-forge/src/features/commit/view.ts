// Vue « Commit » de la barre latérale Git Spark (au-dessus du Graphe) : fichiers à indexer / désindexer, message
// conventionnel, pull (rebase) facultatif avant le commit, Commit ou Commit & Push. Suit le dépôt de l'éditeur actif.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import { PushError, type GitCommands } from '../../git/commands.ts';
import type { WorkingChange } from '../../git/parsers/status.ts';
import type { Repos } from '../../git/repos.ts';
import { errorText, showConflictsView, whereToFinish } from '../../shared/errors.ts';
import { revisionUri } from '../../shared/revisions.ts';
import { canCommit } from './message.ts';

const REFRESH_DELAY = 300;

/** Messages de la webview ; `root` : dépôt affiché quand l'utilisateur a agi. */
type Incoming = { root?: string } & (
  | { type: 'ready' }
  | { type: 'stage'; paths: string[] }
  | { type: 'unstage'; paths: string[] }
  | { type: 'open'; change: WorkingChange; staged: boolean }
  | { type: 'setPull'; value: boolean }
  | { type: 'commit'; message: string; push: boolean }
);

export class CommitView implements vscode.WebviewViewProvider, vscode.Disposable {
  readonly #git: GitCommands;
  readonly #repos: Repos;
  readonly #extensionUri: vscode.Uri;
  readonly #disposables: vscode.Disposable[];
  #view: vscode.WebviewView | undefined;
  #root: string | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(git: GitCommands, repos: Repos, extensionUri: vscode.Uri) {
    this.#git = git;
    this.#repos = repos;
    this.#extensionUri = extensionUri;
    this.#disposables = [
      vscode.window.registerWebviewViewProvider('gitForge.commitView', this),
      // Seul le dépôt affiché compte (ou n'importe lequel tant qu'aucun n'est affiché).
      repos.onDidChange((repo) => {
        if (!this.#root || repo.rootUri.fsPath === this.#root) this.#schedule();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.#schedule()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitForge.commit.pullBeforeCommit')) this.#schedule();
      }),
    ];
  }

  /** Dépôt affiché (tests e2e). */
  get root(): string | undefined {
    return this.#root;
  }

  dispose(): void {
    clearTimeout(this.#timer);
    for (const disposable of this.#disposables) disposable.dispose();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view;
    const media = vscode.Uri.joinPath(this.#extensionUri, 'media');
    const dist = vscode.Uri.joinPath(this.#extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [media, dist] };
    view.webview.html = this.#html(view.webview, media, dist);
    view.webview.onDidReceiveMessage((message: Incoming) => this.#receive(message));
    view.onDidChangeVisibility(() => {
      if (view.visible) this.#schedule();
    });
    view.onDidDispose(() => {
      this.#view = undefined;
    });
  }

  /**
   * Dépôt à afficher : celui du fichier de l'éditeur actif ; sinon (diff, sortie, réglages…) celui déjà affiché ; à
   * défaut le premier dépôt ouvert.
   */
  #resolveRoot(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    const active = editor?.document.uri.scheme === 'file' ? this.#repos.locate(editor.document.fileName)?.root : undefined;
    if (active) return active;
    if (this.#root && this.#repos.roots().includes(this.#root)) return this.#root;
    return this.#repos.roots()[0];
  }

  async refresh(): Promise<void> {
    const root = this.#resolveRoot();
    if (!root) {
      this.#root = undefined;
      this.#post({ type: 'state', root: '', repo: '', branch: '', staged: [], unstaged: [], pull: this.#pull() });
      return;
    }
    try {
      const [changes, status] = await Promise.all([this.#git.workingChanges(root), this.#git.status(root)]);
      if (this.#resolveRoot() !== root) return;
      // Le dépôt n'est retenu qu'une fois lu : l'écran et les actions visent toujours le même.
      this.#root = root;
      this.#post({
        type: 'state',
        root,
        repo: path.basename(root),
        branch: status.branch.head ?? 'HEAD',
        upstream: status.branch.upstream,
        staged: changes.staged,
        unstaged: changes.unstaged,
        pull: this.#pull(),
      });
    } catch {
      // dépôt en cours de modification : relu au prochain changement
    }
  }

  /** Indexe des fichiers (tests e2e, cases à cocher). */
  async stage(paths: string[]): Promise<void> {
    if (this.#root) await this.#run(() => this.#git.stage(this.#root as string, paths));
  }

  /** Commit (et push) des fichiers indexés, après un pull --rebase si la case est cochée. */
  async commit(message: string, push: boolean): Promise<boolean> {
    const root = this.#root;
    if (!root) {
      this.#post({ type: 'busy', busy: false });
      return false;
    }
    this.#post({ type: 'busy', busy: true });
    let committed = false;
    try {
      committed = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Commit') }, async (progress) => {
        // Rebase, cherry-pick ou revert en cours : à terminer d'abord. Un merge en cours se termine par ce commit.
        const operation = await this.#git.operation(root);
        if (operation && operation.kind !== 'merge') {
          void vscode.window.showWarningMessage(vscode.l10n.t('A {0} is in progress: finish it {1} before committing here.', operation.kind, whereToFinish()));
          return false;
        }
        if (this.#pull() && !operation) {
          progress.report({ message: vscode.l10n.t('Pulling (rebase)…') });
          const pulled = await this.#git.pullBeforeCommit(root);
          if (pulled === 'conflicts' || pulled === 'stash-conflicts') {
            void vscode.window.showWarningMessage(
              pulled === 'conflicts'
                ? vscode.l10n.t('The pull stopped on conflicts: resolve them {0}. Your changes are kept in the stash list. Nothing was committed; your message is kept.', whereToFinish())
                : vscode.l10n.t('The pull is done, but your changes could not be put back exactly as they were: resolve the conflicts {0} (they are also kept in the stash list). Nothing was committed; your message is kept.', whereToFinish()),
            );
            void showConflictsView();
            return false;
          }
          if (pulled === 'no-upstream') vscode.window.setStatusBarMessage(vscode.l10n.t('No remote branch yet: pull skipped.'), 4000);
        }
        if (!canCommit(message, (await this.#git.workingChanges(root)).staged.length)) {
          void vscode.window.showWarningMessage(vscode.l10n.t('Nothing to commit: stage files and write a message.'));
          return false;
        }
        progress.report({ message: vscode.l10n.t('Committing…') });
        await this.#git.commitWithMessage(root, message);
        this.#post({ type: 'committed' });
        if (!push) {
          vscode.window.setStatusBarMessage(vscode.l10n.t('Committed.'), 4000);
          return true;
        }
        progress.report({ message: vscode.l10n.t('Pushing…') });
        try {
          const target = await this.#git.pushCurrent(root);
          void vscode.window.showInformationMessage(vscode.l10n.t('Committed and pushed to {0}.', target));
        } catch (err) {
          const reason =
            err instanceof PushError
              ? err.reason === 'detached'
                ? vscode.l10n.t('HEAD is detached: check out a branch to push.')
                : vscode.l10n.t('This repository has no remote to push to.')
              : errorText(err);
          void vscode.window.showErrorMessage(vscode.l10n.t('Committed, but the push failed: {0}', reason));
        }
        return true;
      });
    } catch (err) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Commit failed: {0}', errorText(err)));
    } finally {
      this.#post({ type: 'busy', busy: false });
      await this.refresh();
    }
    return committed;
  }

  async #receive(message: Incoming): Promise<void> {
    try {
      await this.#handle(message);
    } catch (err) {
      void vscode.window.showErrorMessage(errorText(err));
    }
  }

  async #handle(message: Incoming): Promise<void> {
    const root = this.#root;
    // Action faite sur un autre dépôt que celui retenu (affichage en retard) : ignorée, l'écran est relu.
    if (message.type !== 'ready' && message.root !== undefined && message.root !== root) {
      await this.refresh();
      return;
    }
    switch (message.type) {
      case 'ready':
        await this.refresh();
        break;
      case 'stage':
        if (root) await this.#run(() => this.#git.stage(root, message.paths));
        break;
      case 'unstage':
        if (root) await this.#run(() => this.#git.unstage(root, message.paths));
        break;
      case 'open':
        if (root) await this.#open(root, message.change, message.staged);
        break;
      case 'setPull': {
        // Réglage de l'espace de travail s'il y en a un (sinon il masquerait le réglage utilisateur).
        const config = vscode.workspace.getConfiguration('gitForge');
        const workspace = config.inspect<boolean>('commit.pullBeforeCommit')?.workspaceValue !== undefined;
        await config.update('commit.pullBeforeCommit', message.value, workspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
        break;
      }
      case 'commit':
        await this.commit(message.message, message.push);
        break;
    }
  }

  async #run(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      void vscode.window.showErrorMessage(errorText(err));
    }
    await this.refresh();
  }

  /** Diff du fichier : HEAD ↔ index (indexé), index ↔ fichier (non indexé) ; fichier non suivi ou en conflit : ouvert. */
  async #open(root: string, change: WorkingChange, staged: boolean): Promise<void> {
    const file = vscode.Uri.file(path.join(root, change.path));
    const name = path.posix.basename(change.path);
    if (change.status === '?' || change.status === 'U') {
      await vscode.commands.executeCommand('vscode.open', file);
      return;
    }
    const index = vscode.l10n.t('Index');
    if (staged) {
      // SHA réel de HEAD : un onglet de diff resté ouvert ne montre jamais un ancien HEAD sous le même nom.
      const head = (await this.#git.revParse(root, 'HEAD')) ?? '';
      const left = revisionUri({ root, path: change.oldPath ?? change.path, sha: change.status === 'A' ? '' : head });
      const right = revisionUri({ root, path: change.path, sha: change.status === 'D' ? '' : ':0' });
      await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (HEAD ↔ ${index})`);
    } else {
      const left = revisionUri({ root, path: change.path, sha: ':0' });
      const right = change.status === 'D' ? revisionUri({ root, path: change.path, sha: '' }) : file;
      await vscode.commands.executeCommand('vscode.diff', left, right, `${name} (${index} ↔ ${vscode.l10n.t('Working Tree')})`);
    }
  }

  #pull(): boolean {
    return vscode.workspace.getConfiguration('gitForge').get<boolean>('commit.pullBeforeCommit', true);
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.refresh(), REFRESH_DELAY);
  }

  #post(message: unknown): void {
    void this.#view?.webview.postMessage(message);
  }

  #html(webview: vscode.Webview, media: vscode.Uri, dist: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const text = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const strings = {
      types: {
        feat: vscode.l10n.t('A new feature'),
        fix: vscode.l10n.t('A bug fix'),
        refactor: vscode.l10n.t('A code change that neither fixes a bug nor adds a feature'),
        perf: vscode.l10n.t('A performance improvement'),
        style: vscode.l10n.t('Formatting only (spaces, semicolons…), no change in behavior'),
        docs: vscode.l10n.t('Documentation only'),
        test: vscode.l10n.t('Adding or fixing tests'),
        build: vscode.l10n.t('Build system or dependencies'),
        ci: vscode.l10n.t('Continuous integration configuration'),
        chore: vscode.l10n.t('Other changes (tooling, maintenance)'),
        revert: vscode.l10n.t('Reverts a previous commit'),
      },
      noType: vscode.l10n.t('type…'),
      commit: vscode.l10n.t('Commit'),
      commitPush: vscode.l10n.t('Commit & Push'),
      staged: vscode.l10n.t('Staged Changes'),
      unstaged: vscode.l10n.t('Changes'),
      stageAll: vscode.l10n.t('Stage (add to the commit)'),
      unstageAll: vscode.l10n.t('Unstage (remove from the commit)'),
      noRepo: vscode.l10n.t('Open a file of a Git repository.'),
      noChanges: vscode.l10n.t('No changes.'),
      noUpstream: vscode.l10n.t('(no remote branch yet)'),
      status: {
        M: vscode.l10n.t('Modified'),
        A: vscode.l10n.t('Added'),
        D: vscode.l10n.t('Deleted'),
        R: vscode.l10n.t('Renamed'),
        C: vscode.l10n.t('Copied'),
        T: vscode.l10n.t('Type changed'),
        U: vscode.l10n.t('Conflict'),
        '?': vscode.l10n.t('Untracked (new file)'),
      },
    };
    const json = JSON.stringify(strings).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="${text(vscode.env.language)}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(media, 'commit.css'))}">
</head>
<body>
<div class="composer">
  <div id="branch"></div>
  <div class="options">
    <div class="type-picker">
      <button id="type" type="button" class="chip" aria-haspopup="listbox" aria-expanded="false" title="${text(vscode.l10n.t('Conventional commit type'))}"></button>
      <ul id="type-list" role="listbox" hidden></ul>
    </div>
    <input id="scope" type="text" placeholder="${text(vscode.l10n.t('scope (optional)'))}">
    <button id="breaking" type="button" class="toggle" aria-pressed="false" aria-label="${text(vscode.l10n.t('breaking'))}" title="${text(vscode.l10n.t('Breaking change: adds ! after the type'))}">!</button>
  </div>
  <div class="message-box">
    <textarea id="message" placeholder="${text(vscode.l10n.t('Message (Ctrl+Enter to commit)'))}"></textarea>
    <span id="counter"></span>
  </div>
  <div class="actions">
    <button id="commit" type="button" class="primary"></button>
    <button id="commit-push" type="button" class="secondary"></button>
  </div>
  <label class="switch"><input id="pull" type="checkbox"><span class="track"></span><span>${text(vscode.l10n.t('Pull before commit (rebase)'))}</span><span id="pull-hint"></span></label>
</div>
<div id="files"></div>
<script id="strings" type="application/json">${json}</script>
<script nonce="${nonce}" src="${webview.asWebviewUri(vscode.Uri.joinPath(dist, 'commit-view.js'))}"></script>
</body>
</html>`;
  }
}
