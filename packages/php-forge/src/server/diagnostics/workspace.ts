// Diagnostics de tout le workspace en arrière-plan (phpForge.diagnostics.scope = workspace) : la main est rendue
// dès que le budget de temps est dépassé ; une nouvelle passe annule la précédente ; un fichier en erreur est
// sauté ; les fichiers qui n'ont plus d'alerte (ou qui ont disparu) sont effacés.
import type { Diagnostic } from 'vscode-languageserver/node';

export interface WorkspaceJob {
  files(): string[];
  /** Documents ouverts : publiés à chaque modification, pas par la passe */
  skip(uri: string): boolean;
  compute(uri: string): Diagnostic[] | undefined;
  publish(uri: string, diagnostics: Diagnostic[]): void;
  error?(uri: string, err: unknown): void;
}

export class WorkspaceDiagnostics {
  readonly #published = new Set<string>();
  #generation = 0;

  get published(): ReadonlySet<string> {
    return this.#published;
  }

  /** `budget` : millisecondes de calcul entre deux retours à la boucle d'événements. */
  async run(job: WorkspaceJob, budget = 25): Promise<void> {
    const generation = ++this.#generation;
    const seen = new Set<string>();
    let slice = Date.now();
    for (const uri of job.files()) {
      if (generation !== this.#generation) return;
      if (job.skip(uri)) continue;
      seen.add(uri);
      let diagnostics: Diagnostic[];
      try {
        diagnostics = job.compute(uri) ?? [];
      } catch (err) {
        job.error?.(uri, err);
        diagnostics = [];
      }
      if (diagnostics.length || this.#published.has(uri)) job.publish(uri, diagnostics);
      this.record(uri, diagnostics.length > 0);
      if (Date.now() - slice >= budget) {
        await new Promise((resolve) => setImmediate(resolve));
        slice = Date.now();
      }
    }
    if (generation !== this.#generation) return;
    for (const uri of [...this.#published]) {
      if (seen.has(uri) || job.skip(uri)) continue;
      job.publish(uri, []);
      this.#published.delete(uri);
    }
  }

  /** Publication faite hors de la passe (document fermé) : la passe saura l'effacer. */
  record(uri: string, hasDiagnostics: boolean): void {
    if (hasDiagnostics) this.#published.add(uri);
    else this.#published.delete(uri);
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
