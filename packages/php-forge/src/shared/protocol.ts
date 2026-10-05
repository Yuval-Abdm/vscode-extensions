// Contrat client ↔ serveur : options d'initialisation, réglages, requêtes et notifications propres à PHP Forge.
import type { Level } from '../server/diagnostics/policy.ts';
import type { FormatSettings } from '../server/format/format.ts';
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
  diagnostics: {
    /** Niveau par code de diagnostic ; « off » : désactivé */
    rules: Record<string, Level>;
    /** Documents ouverts seulement, ou tout le workspace en arrière-plan */
    scope: 'openFiles' | 'workspace';
  };
  /** Globs des dossiers librairie : indexés, jamais diagnostiqués */
  libraryPaths: string[];
  /** CodeLens du nombre de références et d'implémentations */
  codeLens: { references: boolean; implementations: boolean };
  /** Trier les use et retirer les inutilisés à l'enregistrement */
  organizeUsesOnSave: boolean;
  completion: { autoImport: boolean };
  /** Formateur (l'indentation vient de l'éditeur) */
  format: FormatSettings;
  /** Schéma SQL : globs des fichiers .sql, relatifs à chaque dossier du workspace */
  sql: { schema: string[] };
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
  diagnostics: { rules: {}, scope: 'workspace' },
  libraryPaths: ['**/vendor/**', '**/PHPExcel/**', '**/Google/Api/**'],
  codeLens: { references: true, implementations: true },
  organizeUsesOnSave: false,
  completion: { autoImport: true },
  format: { enable: true, braces: 'psr12', alignArrows: false, alignAssignments: false, trailingCommas: false, lineLength: 120 },
  sql: { schema: ['sql/**/*.sql', 'migrations/**/*.sql', 'database/**/*.sql'] },
};

/** Réglages complets à partir de valeurs partielles (options d'initialisation, changement de configuration). */
export function mergeSettings(partial: Partial<Settings> | undefined): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...partial,
    inlayHints: { ...DEFAULT_SETTINGS.inlayHints, ...partial?.inlayHints },
    includes: { ...DEFAULT_SETTINGS.includes, ...partial?.includes },
    diagnostics: { ...DEFAULT_SETTINGS.diagnostics, ...partial?.diagnostics },
    codeLens: { ...DEFAULT_SETTINGS.codeLens, ...partial?.codeLens },
    completion: { ...DEFAULT_SETTINGS.completion, ...partial?.completion },
    format: { ...DEFAULT_SETTINGS.format, ...partial?.format },
    sql: { ...DEFAULT_SETTINGS.sql, ...partial?.sql },
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

/** Lien vers un fichier de la chaîne d'inclusion ; `label` : « pages/home.php:3 ». */
export interface IncludeLink {
  uri: string;
  line: number;
  label: string;
}

/** Appelants d'un fichier (sites d'inclusion). */
export const INCLUDERS_REQUEST = 'phpForge/includers';

/** Appelants et fichiers inclus d'un fichier, pour la vue « Include tree ». */
export const INCLUDE_TREE_REQUEST = 'phpForge/includeTree';

export interface IncludeTree {
  includedBy: IncludeLink[];
  includes: IncludeLink[];
}

/** Crée, met à jour ou supprime la baseline des alertes existantes. */
export const BASELINE_REQUEST = 'phpForge/baseline';

export interface BaselineParams {
  action: 'create' | 'update' | 'clear';
}

export interface BaselineResult {
  files: number;
  entries: number;
}

/** Alertes masquées par la baseline (barre d'état). */
export const BASELINE_STATUS_NOTIFICATION = 'phpForge/baselineStatus';

export interface BaselineStatus {
  hidden: number;
  active: boolean;
}
