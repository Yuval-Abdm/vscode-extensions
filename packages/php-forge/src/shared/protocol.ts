// Contrat client ↔ serveur : options d'initialisation, réglages, requêtes et notifications propres à PHP Forge.
import type { IndexStats } from '../server/index/indexer.ts';

export interface Settings {
  exclude: string[];
  maxFileSize: number;
}

export const DEFAULT_SETTINGS: Settings = {
  exclude: ['**/node_modules/**', '**/.git/**'],
  maxFileSize: 2_000_000,
};

export interface InitOptions {
  /** Dossier de stockage de l'extension (cache de l'index) */
  storagePath?: string;
  /** Traductions de l'interface (vscode.l10n.uri) */
  l10nBundle?: string;
  settings?: Partial<Settings>;
}

/** Réindexe tout le workspace (sans cache pour les fichiers modifiés). */
export const REINDEX_REQUEST = 'phpForge/reindex';
/** Envoyée à la fin de l'indexation de chaque dossier. */
export const INDEXED_NOTIFICATION = 'phpForge/indexed';

export interface IndexedParams {
  folder: string;
  stats: IndexStats;
}
