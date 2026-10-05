// Variables venues d'autres fichiers (moteur d'inclusion) : type, origine et noms disponibles à une position, par
// document. Le serveur enregistre un fournisseur pour les portées de noms de chaque document ouvert ; l'inférence,
// le survol, la définition et la complétion le consultent sans dépendre de l'analyse.
import type { NameScope, Position, TypeExpr } from '../../shared/types.ts';

export interface ExternalVariable {
  type?: TypeExpr;
  /** Affectation d'origine ; `label` : « includes/db.php:2 » */
  origin?: { uri: string; line: number; label: string };
  /** Variable venue de la requête (`extract($_POST)`) */
  request?: { from: string; line: number };
}

export interface ExternalVariables {
  variable(name: string, at: Position): ExternalVariable | undefined;
  /** Variables disponibles à la position (fichiers inclus avant, appelants) */
  names(at: Position): string[];
}

const providers = new WeakMap<NameScope[], ExternalVariables>();

export function registerExternal(scopes: NameScope[], provider: ExternalVariables): void {
  providers.set(scopes, provider);
}

export function externalFor(scopes: NameScope[]): ExternalVariables | undefined {
  return providers.get(scopes);
}
