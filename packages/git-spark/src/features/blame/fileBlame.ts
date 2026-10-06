// Blame du fichier entier, activé par document (commande bascule) : marge à gauche avec auteur et date par bloc,
// liseré coloré selon l'âge du commit.
import * as vscode from 'vscode';
import { isUncommitted } from '../../git/parsers/blame.ts';
import type { Repos } from '../../git/repos.ts';
import { CancelledError } from '../../git/runner.ts';
import { shortDate } from '../../shared/dates.ts';
import { ageBucket, blameBlocks, truncate } from './format.ts';
import type { BlameService } from './service.ts';

/** Couleur du liseré par tranche d'âge (ageBucket) : du plus récent au plus ancien. */
const AGE_COLORS = ['#f0883e', '#d29922', '#8fbc5a', '#4d8fb8', '#6e7681'];
const REFRESH_DELAY = 300;

export class FileBlame implements vscode.Disposable {
  readonly #service: BlameService;
  /** Documents (URI) dont le blame est affiché, avec le HEAD de leur dernier rendu. */
  readonly #enabled = new Map<string, string | undefined>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Calcul en cours par document : un nouveau rendu annule le précédent. */
  readonly #aborts = new Map<string, AbortController>();
  readonly #types = AGE_COLORS.map((borderColor) =>
    vscode.window.createTextEditorDecorationType({
      before: {
        width: '24ch',
        margin: '0 1.5em 0 0',
        color: new vscode.ThemeColor('gitSpark.blameForeground'),
        border: '0 0 0 3px solid',
        borderColor,
      },
    }),
  );
  readonly #disposables: vscode.Disposable[];

  constructor(service: BlameService, repos: Repos) {
    this.#service = service;
    this.#disposables = [
      ...this.#types,
      vscode.commands.registerCommand('gitSpark.toggleFileBlame', () => this.toggle()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.#refreshAll()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length) this.#scheduleDocument(e.document);
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const key = doc.uri.toString();
        this.#enabled.delete(key);
        this.#aborts.get(key)?.abort();
        this.#aborts.delete(key);
      }),
      repos.onDidChange(() => {
        // Seul un changement de HEAD (commit, checkout…) rend la marge périmée.
        for (const editor of vscode.window.visibleTextEditors) {
          const key = editor.document.uri.toString();
          if (this.#enabled.has(key) && this.#service.head(editor.document.fileName) !== this.#enabled.get(key)) void this.#render(editor);
        }
      }),
    ];
  }

  isEnabled(uri: vscode.Uri): boolean {
    return this.#enabled.has(uri.toString());
  }

  async toggle(editor = vscode.window.activeTextEditor): Promise<void> {
    if (!editor) return;
    const doc = editor.document;
    const key = doc.uri.toString();
    if (this.#enabled.has(key)) {
      this.#enabled.delete(key);
      this.#aborts.get(key)?.abort();
      for (const shown of this.#editorsOf(key)) this.#clear(shown);
      return;
    }
    const noBlame = () =>
      vscode.window.showInformationMessage(
        vscode.l10n.t('No blame for this file: it is not tracked by Git, or it is too long (gitSpark.blame.maxLines).'),
      );
    // Révision ou côté gauche d'un diff : leur texte n'est pas celui du fichier sur disque.
    if (doc.uri.scheme !== 'file') return void noBlame();
    this.#enabled.set(key, undefined);
    const shown = await this.#render(editor);
    // HEAD pas encore lu par vscode.git : le blame s'affichera quand il le sera (changement de HEAD).
    if (shown === false && this.#service.head(doc.fileName) !== undefined && this.#enabled.delete(key)) void noBlame();
  }

  dispose(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    for (const abort of this.#aborts.values()) abort.abort();
    for (const disposable of this.#disposables) disposable.dispose();
  }

  #editorsOf(key: string): vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter((editor) => editor.document.uri.toString() === key);
  }

  #clear(editor: vscode.TextEditor): void {
    for (const type of this.#types) editor.setDecorations(type, []);
  }

  #refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (this.isEnabled(editor.document.uri)) void this.#render(editor);
    }
  }

  #scheduleDocument(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    if (!this.#enabled.has(key)) return;
    clearTimeout(this.#timers.get(key));
    this.#timers.set(
      key,
      setTimeout(() => {
        this.#timers.delete(key);
        for (const editor of this.#editorsOf(key)) void this.#render(editor);
      }, REFRESH_DELAY),
    );
  }

  /** Dessine la marge : true si elle est dessinée, false s'il n'y a pas de blame, undefined si le rendu est périmé. */
  async #render(editor: vscode.TextEditor): Promise<boolean | undefined> {
    const doc = editor.document;
    const key = doc.uri.toString();
    const version = doc.version;
    const head = this.#service.head(doc.fileName);
    this.#aborts.get(key)?.abort();
    const abort = new AbortController();
    this.#aborts.set(key, abort);
    let blame;
    try {
      blame = await this.#service.fileBlame(doc, abort.signal);
    } catch (err) {
      if (err instanceof CancelledError) return undefined;
      throw err;
    }
    // Désactivé, ou document modifié pendant le calcul : un autre rendu suit.
    if (!this.#enabled.has(key) || doc.version !== version) return undefined;
    this.#enabled.set(key, head);
    if (!blame) {
      this.#clear(editor);
      return false;
    }
    const now = Date.now() / 1000;
    const language = vscode.env.language;
    const byAge: vscode.DecorationOptions[][] = AGE_COLORS.map(() => []);
    for (const block of blameBlocks(blame.result)) {
      const commit = blame.result.commits.get(block.sha);
      if (!commit) continue;
      const uncommitted = isUncommitted(block.sha);
      const label = uncommitted ? vscode.l10n.t('Uncommitted') : `${truncate(commit.author, 12)} ${shortDate(commit.authorTime, language)}`;
      const target = byAge[uncommitted ? 0 : ageBucket(commit.authorTime, now)];
      for (let line = block.start; line <= block.end && line < doc.lineCount; line++) {
        target.push({
          range: new vscode.Range(line, 0, line, 0),
          renderOptions: { before: { contentText: line === block.start ? label : ' ' } },
        });
      }
    }
    this.#types.forEach((type, i) => editor.setDecorations(type, byAge[i]));
    return true;
  }
}
