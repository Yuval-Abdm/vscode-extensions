// Blame de la ligne du curseur : texte grisé en fin de ligne, survol détaillé et barre d'état.
import * as vscode from 'vscode';
import type { Repos } from '../../git/repos.ts';
import { CancelledError } from '../../git/runner.ts';
import { absoluteDate, relativeTime } from '../../shared/dates.ts';
import { commitFileArgs } from '../../shared/revisions.ts';
import { DEFAULT_FORMAT, formatBlame, truncate } from './format.ts';
import type { BlameService, LineInfo } from './service.ts';

/** Délai après le dernier mouvement du curseur avant de calculer le blame. */
const DELAY = 150;
const HOVER_COMMANDS = ['gitForge.diffWithPrevious', 'gitForge.openRevision', 'gitForge.copySha'];

export class LineBlame implements vscode.Disposable {
  readonly #service: BlameService;
  readonly #decoration = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 3em', color: new vscode.ThemeColor('gitForge.blameForeground') },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  readonly #status = vscode.window.createStatusBarItem('gitForge.blame', vscode.StatusBarAlignment.Right, 100);
  readonly #disposables: vscode.Disposable[];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #abort: AbortController | undefined;
  #abortFile: string | undefined;
  #shown: { editor: vscode.TextEditor; info: LineInfo; text: string } | undefined;
  /** HEAD du dépôt lors du dernier calcul (même sans résultat : HEAD pas encore lu par vscode.git…). */
  #attemptHead: string | undefined;

  constructor(service: BlameService, repos: Repos) {
    this.#service = service;
    this.#status.name = vscode.l10n.t('Git Forge blame');
    this.#status.command = 'gitForge.showLineCommit';
    this.#disposables = [
      this.#decoration,
      this.#status,
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) this.#schedule();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.#schedule()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === vscode.window.activeTextEditor?.document && e.contentChanges.length) this.#schedule();
      }),
      repos.onDidChange(() => {
        // Nouveau commit, checkout, ou HEAD enfin connu à l'ouverture du dépôt : le calcul précédent est périmé.
        const editor = vscode.window.activeTextEditor;
        if (editor && this.#service.head(editor.document.fileName) !== this.#attemptHead) this.#schedule();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitForge.blame')) this.#schedule();
      }),
      vscode.commands.registerCommand('gitForge.showLineCommit', () => this.#showLineCommit()),
    ];
    this.#schedule();
  }

  /** Texte affiché en fin de ligne (tests e2e). */
  get currentText(): string | undefined {
    return this.#shown?.text;
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#abort?.abort();
    for (const disposable of this.#disposables) disposable.dispose();
  }

  #clear(): void {
    this.#shown?.editor.setDecorations(this.#decoration, []);
    this.#shown = undefined;
    this.#status.hide();
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    this.#clear();
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file' || editor.selections.length !== 1) return;
    this.#timer = setTimeout(() => void this.#render(editor), DELAY);
  }

  async #render(editor: vscode.TextEditor): Promise<void> {
    const doc = editor.document;
    const line = editor.selection.active.line;
    const version = doc.version;
    this.#attemptHead = this.#service.head(doc.fileName);
    // Changer de fichier annule le calcul en cours de l'ancien.
    if (this.#abortFile !== doc.fileName || !this.#abort) {
      this.#abort?.abort();
      this.#abort = new AbortController();
      this.#abortFile = doc.fileName;
    }
    let info: LineInfo | undefined;
    let message = '';
    try {
      info = await this.#service.lineInfo(doc, line, this.#abort.signal);
      if (info && !info.uncommitted) message = await this.#service.message(info.root, info.commit.sha).catch(() => info?.commit.summary ?? '');
    } catch (err) {
      if (err instanceof CancelledError) return;
      throw err;
    }
    // Résultat périmé : le curseur ou le document ont changé pendant le calcul.
    if (!info || vscode.window.activeTextEditor !== editor || editor.selection.active.line !== line || doc.version !== version) return;
    const config = vscode.workspace.getConfiguration('gitForge.blame');
    const commit = info.commit;
    const ago = relativeTime(commit.authorTime, Date.now(), vscode.env.language);
    const text = info.uncommitted
      ? vscode.l10n.t('You • Uncommitted changes')
      : formatBlame(config.get<string>('format', DEFAULT_FORMAT), { author: commit.author, date: ago, message: commit.summary, sha: commit.sha });
    const end = doc.lineAt(line).range.end;
    editor.setDecorations(this.#decoration, [
      {
        range: new vscode.Range(end, end),
        hoverMessage: info.uncommitted ? undefined : hover(info, message),
        renderOptions: { after: { contentText: truncate(text, 120) } },
      },
    ]);
    this.#shown = { editor, info, text };
    if (config.get<boolean>('statusBar', true) && !info.uncommitted) {
      this.#status.text = `$(git-commit) ${commit.author}, ${ago}`;
      this.#status.tooltip = commit.summary;
      this.#status.show();
    }
  }

  async #showLineCommit(): Promise<void> {
    const shown = this.#shown;
    if (!shown || shown.info.uncommitted) return;
    const commit = shown.info.commit;
    const compare = vscode.l10n.t('Compare with previous revision');
    const copy = vscode.l10n.t('Copy SHA');
    const choice = await vscode.window.showInformationMessage(`${commit.sha.slice(0, 8)} · ${commit.author}: ${commit.summary}`, compare, copy);
    const args = commitFileArgs(shown.info.root, commit);
    if (choice === compare) await vscode.commands.executeCommand('gitForge.diffWithPrevious', args);
    else if (choice === copy) await vscode.commands.executeCommand('gitForge.copySha', args);
  }
}

function link(command: string, args: unknown): string {
  return `command:${command}?${encodeURIComponent(JSON.stringify([args]))}`;
}

function hover(info: LineInfo, message: string): vscode.MarkdownString {
  const commit = info.commit;
  const language = vscode.env.language;
  const args = commitFileArgs(info.root, commit);
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = { enabledCommands: HOVER_COMMANDS };
  md.appendMarkdown(`$(git-commit) \`${commit.sha.slice(0, 8)}\` · `);
  md.appendText(`${commit.author} <${commit.authorMail}>`);
  md.appendMarkdown(` · ${absoluteDate(commit.authorTime, language)} (${relativeTime(commit.authorTime, Date.now(), language)})\n\n`);
  md.appendText(message || commit.summary);
  md.appendMarkdown('\n\n---\n\n');
  md.appendMarkdown(`[$(diff) ${vscode.l10n.t('Compare with previous revision')}](${link('gitForge.diffWithPrevious', args)})`);
  md.appendMarkdown(` · [$(go-to-file) ${vscode.l10n.t('Open file at this commit')}](${link('gitForge.openRevision', args)})`);
  md.appendMarkdown(` · [$(copy) ${vscode.l10n.t('Copy SHA')}](${link('gitForge.copySha', args)})`);
  return md;
}
