// Diagnostics de tout le workspace en arrière-plan (phpForge.diagnostics.scope = workspace) : fichiers traités par
// lots en rendant la main entre deux lots ; une nouvelle passe annule la précédente ; les fichiers qui n'ont plus
// d'alerte (ou qui ont disparu) sont effacés.
import type { Diagnostic } from 'vscode-languageserver/node';

export interface WorkspaceJob {
  files(): string[];
  /** Documents ouverts : publiés à chaque modification, pas par la passe */
  skip(uri: string): boolean;
  compute(uri: string): Diagnostic[] | undefined;
  publish(uri: string, diagnostics: Diagnostic[]): void;
}

export class WorkspaceDiagnostics {
  readonly #published = new Set<string>();
  #generation = 0;

  get published(): ReadonlySet<string> {
    return this.#published;
  }

  async run(job: WorkspaceJob, batch = 20): Promise<void> {
    const generation = ++this.#generation;
    const seen = new Set<string>();
    let count = 0;
    for (const uri of job.files()) {
      if (generation !== this.#generation) return;
      if (job.skip(uri)) continue;
      seen.add(uri);
      const diagnostics = job.compute(uri) ?? [];
      if (diagnostics.length || this.#published.has(uri)) job.publish(uri, diagnostics);
      if (diagnostics.length) this.#published.add(uri);
      else this.#published.delete(uri);
      if (++count % batch === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    if (generation !== this.#generation) return;
    for (const uri of [...this.#published]) {
      if (seen.has(uri) || job.skip(uri)) continue;
      job.publish(uri, []);
      this.#published.delete(uri);
    }
  }

  cancel(): void {
    this.#generation++;
  }

  clear(publish: (uri: string, diagnostics: Diagnostic[]) => void): void {
    this.cancel();
    for (const uri of this.#published) publish(uri, []);
    this.#published.clear();
  }

  /** Document fermé : la passe peut de nouveau le publier ; document ouvert : il ne compte plus parmi les publiés. */
  forget(uri: string): void {
    this.#published.delete(uri);
  }
}
