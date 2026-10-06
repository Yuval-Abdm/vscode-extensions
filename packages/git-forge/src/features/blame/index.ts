// Fonction « blame » : service partagé, blame de la ligne du curseur et blame du fichier entier.
import * as vscode from 'vscode';
import type { GitCommands } from '../../git/commands.ts';
import type { Repos } from '../../git/repos.ts';
import { FileBlame } from './fileBlame.ts';
import { LineBlame } from './lineBlame.ts';
import { BlameService } from './service.ts';

export class BlameFeature implements vscode.Disposable {
  readonly service: BlameService;
  readonly line: LineBlame;
  readonly file: FileBlame;
  readonly #closed: vscode.Disposable;

  constructor(git: GitCommands, repos: Repos) {
    this.service = new BlameService(git, repos, () => vscode.workspace.getConfiguration('gitForge.blame').get<number>('maxLines', 20000));
    this.line = new LineBlame(this.service, repos);
    this.file = new FileBlame(this.service, repos);
    this.#closed = vscode.workspace.onDidCloseTextDocument((doc) => this.service.forget(doc.fileName));
  }

  dispose(): void {
    this.line.dispose();
    this.file.dispose();
    this.#closed.dispose();
  }
}
