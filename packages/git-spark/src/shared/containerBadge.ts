// Pastille de l'icône Git Spark (barre d'activité) : VS Code l'affiche à partir des pastilles des vues du conteneur.
// La vue Commit est une webview, créée seulement à la première ouverture du conteneur : avant cela, la pastille est
// posée sur une vue en arbre de Git Spark, créée dès l'activation (et invisible tant que le conteneur est fermé).
import type * as vscode from 'vscode';

interface Carrier {
  badge?: vscode.ViewBadge;
}

const carriers: Carrier[] = [];
let main: Carrier | undefined;
let current: vscode.ViewBadge | undefined;

function apply(): void {
  const target = main ?? carriers[0];
  for (const carrier of [main, ...carriers]) {
    if (carrier) carrier.badge = carrier === target ? current : undefined;
  }
}

/** Vue en arbre de Git Spark pouvant porter la pastille tant que la vue Commit n'est pas créée. */
export function registerBadgeCarrier(view: Carrier): vscode.Disposable {
  carriers.push(view);
  apply();
  return {
    dispose: () => {
      carriers.splice(carriers.indexOf(view), 1);
      apply();
    },
  };
}

/** Vue Commit (webview) : porte la pastille dès qu'elle existe ; undefined quand elle est fermée. */
export function setBadgeOwner(view: Carrier | undefined): void {
  main = view;
  apply();
}

export function setContainerBadge(badge: vscode.ViewBadge | undefined): void {
  current = badge;
  apply();
}
