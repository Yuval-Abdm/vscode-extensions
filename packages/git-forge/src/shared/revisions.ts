// Fichiers à un commit donné (schéma git-forge:) et commandes communes : comparer avec la révision précédente,
// ouvrir le fichier à un commit, copier le SHA.
import path from 'node:path';
import * as vscode from 'vscode';
import type { GitCommands } from '../git/commands.ts';
import type { BlameCommit } from '../git/parsers/blame.ts';
import { decodeRevision, encodeRevision, type CommitFileArgs, type RevisionRef } from './revisionRef.ts';

export type { CommitFileArgs } from './revisionRef.ts';

export const SCHEME = 'git-forge';

/** URI d'un fichier à un commit ; le chemin garde le nom du fichier (langage et icône corrects). */
export function revisionUri(ref: RevisionRef): vscode.Uri {
  return vscode.Uri.file(path.join(ref.root, ref.path)).with({ scheme: SCHEME, query: encodeRevision(ref) });
}

export class RevisionProvider implements vscode.TextDocumentContentProvider {
  readonly #git: GitCommands;

  constructor(git: GitCommands) {
    this.#git = git;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const ref = decodeRevision(uri.query);
    if (!ref || !ref.sha) return '';
    return this.#git.show(ref.root, ref.sha, ref.path);
  }
}

export function commitFileArgs(root: string, commit: BlameCommit): CommitFileArgs {
  return { root, sha: commit.sha, path: commit.filename, previousSha: commit.previous?.sha, previousPath: commit.previous?.filename };
}

export function registerRevisionCommands(): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('gitForge.diffWithPrevious', (args: CommitFileArgs) => {
      const left = revisionUri({ root: args.root, path: args.previousPath ?? args.path, sha: args.previousSha ?? '' });
      const right = revisionUri({ root: args.root, path: args.path, sha: args.deleted ? '' : args.sha });
      const title = vscode.l10n.t('{0} ({1}^ ↔ {1})', path.posix.basename(args.path), args.sha.slice(0, 7));
      return vscode.commands.executeCommand('vscode.diff', left, right, title);
    }),
    vscode.commands.registerCommand('gitForge.openRevision', (args: CommitFileArgs) =>
      vscode.window.showTextDocument(revisionUri({ root: args.root, path: args.path, sha: args.sha }), { preview: true }),
    ),
    vscode.commands.registerCommand('gitForge.copySha', async (args: { sha: string }) => {
      await vscode.env.clipboard.writeText(args.sha);
      vscode.window.setStatusBarMessage(vscode.l10n.t('SHA copied: {0}', args.sha.slice(0, 7)), 3000);
    }),
  ];
}
