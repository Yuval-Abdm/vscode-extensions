// Baseline (§5.3) : les alertes existantes d'un projet historique sont enregistrées dans
// .vscode/php-forge-baseline.json et masquées ; seules les nouvelles s'affichent. Clé : fichier + code + empreinte
// du message (sans la liste des appelants, qui change) + empreinte du texte de la ligne (robuste aux décalages).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Diagnostic } from 'vscode-languageserver/node';

export const BASELINE_PATH = '.vscode/php-forge-baseline.json';

interface BaselineData {
  version: 1;
  files: Record<string, string[]>;
}

/** Empreinte courte (FNV-1a 32 bits). */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function baselineKey(diagnostic: Diagnostic, lineText: string): string {
  const message = String(diagnostic.message).replace(/ when included from .*$/, '');
  return `${diagnostic.code}|${fingerprint(message)}|${fingerprint(lineText.trim())}`;
}

export class Baseline {
  readonly #files: Map<string, string[]>;

  constructor(data: BaselineData) {
    this.#files = new Map(Object.entries(data.files));
  }

  get size(): number {
    let n = 0;
    for (const keys of this.#files.values()) n += keys.length;
    return n;
  }

  static from(entries: { rel: string; diagnostics: Diagnostic[]; text: string }[]): Baseline {
    const files: Record<string, string[]> = {};
    for (const { rel, diagnostics, text } of entries) {
      if (!diagnostics.length) continue;
      const lines = text.split('\n');
      files[rel] = diagnostics.map((d) => baselineKey(d, lines[d.range.start.line] ?? '')).sort();
    }
    return new Baseline({ version: 1, files });
  }

  static load(root: string): Baseline | undefined {
    try {
      const data = JSON.parse(readFileSync(path.join(root, BASELINE_PATH), 'utf8')) as BaselineData;
      return data.version === 1 && data.files ? new Baseline(data) : undefined;
    } catch {
      return undefined;
    }
  }

  static clear(root: string): void {
    rmSync(path.join(root, BASELINE_PATH), { force: true });
  }

  save(root: string): void {
    const file = path.join(root, BASELINE_PATH);
    mkdirSync(path.dirname(file), { recursive: true });
    const files = Object.fromEntries([...this.#files].sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(file, `${JSON.stringify({ version: 1, files }, null, 2)}\n`);
  }

  /** Diagnostics hors baseline ; chaque entrée de la baseline masque une seule alerte. */
  filter(rel: string, diagnostics: Diagnostic[], text: string): { kept: Diagnostic[]; hidden: number } {
    const keys = this.#files.get(rel);
    if (!keys?.length) return { kept: diagnostics, hidden: 0 };
    const remaining = new Map<string, number>();
    for (const key of keys) remaining.set(key, (remaining.get(key) ?? 0) + 1);
    const lines = text.split('\n');
    const kept: Diagnostic[] = [];
    let hidden = 0;
    for (const diagnostic of diagnostics) {
      const key = baselineKey(diagnostic, lines[diagnostic.range.start.line] ?? '');
      const count = remaining.get(key) ?? 0;
      if (count > 0) {
        remaining.set(key, count - 1);
        hidden++;
      } else {
        kept.push(diagnostic);
      }
    }
    return { kept, hidden };
  }
}
