// Choix de la version de PHP (barre d'état, commande « Select PHP version ») : sans `vscode`, testable.
import type { PhpVersionSource, StatusParams } from '../shared/protocol.ts';

/** Versions proposées, de la plus récente à la plus ancienne */
export const PHP_VERSIONS = ['8.4', '8.3', '8.2', '8.1', '8.0', '7.4', '7.3', '7.2', '7.1', '7.0', '5.6'];

export interface VersionChoice {
  /** Valeur de `phpForge.phpVersion` ; vide : détection automatique */
  value: string;
  current: boolean;
  /** Détection automatique : version trouvée et d'où */
  detected?: string;
  source?: PhpVersionSource;
}

/**
 * « Détection automatique » (avec ce qu'elle trouve aujourd'hui), puis les versions ; la courante est marquée. Une
 * version réglée hors de la liste (« 5.4 ») y est ajoutée.
 */
export function versionChoices(status: StatusParams, configured: string): VersionChoice[] {
  const setting = configured.trim();
  const versions = setting && !PHP_VERSIONS.includes(setting) ? [...PHP_VERSIONS, setting] : PHP_VERSIONS;
  return [
    { value: '', current: !setting, detected: status.phpVersion, source: status.source },
    ...versions.map((value) => ({ value, current: value === setting })),
  ];
}
