// Contrat client ↔ serveur : options d'initialisation, réglages, requêtes et notifications propres à PHP Forge.
import type { IndexStats } from '../server/index/indexer.ts';

export interface InlayHintSettings {
  parameterNames: boolean;
  variableTypes: boolean;
  returnTypes: boolean;
}

export interface Settings {
  exclude: string[];
  maxFileSize: number;
  /** Version de PHP du projet (« 7.3 ») ; vide : détection automatique */
  phpVersion: string;
  /** Extensions PHP (dossiers de phpstorm-stubs) dont les fonctions et classes natives sont connues */
  stubs: string[];
  inlayHints: InlayHintSettings;
  /** Racine web (`$_SERVER['DOCUMENT_ROOT']`) : absolue ou relative au workspace ; vide : racine du workspace */
  documentRoot: string;
  /** Chemin du site sur le serveur, pour les includes en chemin absolu ; vide : remotePath de deploy.json */
  serverRoot: string;
  includes: { maxContexts: number };
  /** Variables définies par l'environnement (auto_prepend_file, framework…) */
  externalGlobals: string[];
}

export const DEFAULT_STUBS = [
  'apache', 'bcmath', 'bz2', 'calendar', 'Core', 'ctype', 'curl', 'date', 'dom', 'exif', 'fileinfo', 'filter', 'ftp',
  'gd', 'gettext', 'gmp', 'hash', 'iconv', 'imap', 'intl', 'json', 'libxml', 'mbstring', 'mysql', 'mysqli', 'openssl',
  'pcntl', 'pcre', 'PDO', 'Phar', 'posix', 'random', 'readline', 'Reflection', 'regex', 'session', 'SimpleXML', 'soap',
  'sockets', 'sodium', 'SPL', 'sqlite3', 'standard', 'superglobals', 'tokenizer', 'xml', 'xmlreader', 'xmlwriter',
  'xsl', 'zip', 'zlib',
];

export const DEFAULT_SETTINGS: Settings = {
  exclude: ['**/node_modules/**', '**/.git/**'],
  maxFileSize: 2_000_000,
  phpVersion: '',
  stubs: DEFAULT_STUBS,
  inlayHints: { parameterNames: true, variableTypes: false, returnTypes: false },
  documentRoot: '',
  serverRoot: '',
  includes: { maxContexts: 64 },
  externalGlobals: [],
};

/** Réglages complets à partir de valeurs partielles (options d'initialisation, changement de configuration). */
export function mergeSettings(partial: Partial<Settings> | undefined): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...partial,
    inlayHints: { ...DEFAULT_SETTINGS.inlayHints, ...partial?.inlayHints },
    includes: { ...DEFAULT_SETTINGS.includes, ...partial?.includes },
  };
}

export interface InitOptions {
  /** Dossier de stockage de l'extension (cache de l'index) */
  storagePath?: string;
  /** Traductions de l'interface (vscode.l10n.uri) */
  l10nBundle?: string;
  settings?: Partial<Settings>;
}

/** Réindexe tout le workspace (le cache est réutilisé pour les fichiers inchangés). */
export const REINDEX_REQUEST = 'phpForge/reindex';
/** Envoyée à la fin de l'indexation de chaque dossier. */
export const INDEXED_NOTIFICATION = 'phpForge/indexed';

export interface IndexedParams {
  folder: string;
  stats: IndexStats;
}

/** Version de PHP utilisée et son origine, pour la barre d'état. */
export const STATUS_NOTIFICATION = 'phpForge/status';

export type PhpVersionSource = 'setting' | 'composer' | 'php' | 'default';

export interface StatusParams {
  phpVersion: string;
  source: PhpVersionSource;
}
