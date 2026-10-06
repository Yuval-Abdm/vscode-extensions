# Git Forge — spécification de conception

- **Date** : 2026-10-06
- **Statut** : validée en conversation (sections 1 à 5), spec écrite
- **Extension** : `yuval-abdm.git-forge`, nom affiché « Git Forge »
- **Emplacement** : `packages/git-forge/` du monorepo `vscode-extensions`
- **Licence** : MIT

## 1. Objectif

Une alternative **gratuite, légère et non intrusive** à GitLens, qui couvre ce que l'auteur utilise au
quotidien (y compris les fonctions réservées à GitLens Pro) et ajoute ce qui lui manque :

- blame en ligne, historique, comparaison, **graphe de commits** sans abonnement ;
- aucune vue imposée, aucune annonce, aucun compte ; chaque fonction se désactive ;
- une **vue Conflits** pour résoudre bloc par bloc, et une commande **Merger en local** qui met les
  branches à jour avant de merger ;
- des opérations Git **guidées** (cherry-pick, revert, reset, rebase interactif) qui montrent ce qui va
  se passer avant de le faire ;
- le lien avec FTP SFTP Deploy et une interface traduite en français.

**Critère de succès** : l'auteur désinstalle GitLens sans rien perdre de ce qu'il utilise, et l'extension
reste fluide sur un dépôt de 10 000+ commits.

**Hors périmètre** : intégration GitHub / GitLab (pull requests, issues), fonctions d'IA, comptes ou
synchronisation en ligne.

## 2. Périmètre et jalons

Tout ce qui suit est dans la 1.0, livré par jalons. Chaque jalon a son propre plan
(`docs/superpowers/plans/`).

| Jalon | Contenu |
|---|---|
| 0.1 | Socle Git (`git/`), blame en ligne, survol, barre d'état, blame du fichier entier |
| 0.2 | Historique d'un fichier et d'une sélection, révisions (schéma `git-forge:`) |
| 0.3 | Vue Conflits, commande Merger en local |
| 0.4 | Comparaison de références, stash, worktrees, déploiement via FTP SFTP Deploy |
| 0.5 | Graphe de commits (webview) |
| 0.6 | Opérations guidées : cherry-pick, revert, reset, rebase interactif |
| 1.0 | Performances mesurées, traduction complète, documentation, publication |

## 3. Architecture

### 3.1 Accès à Git

L'extension exécute le binaire `git` elle-même. Le chemin de `git` et la liste des dépôts ouverts viennent
de l'API de l'extension intégrée `vscode.git` (`getAPI(1)`), déclarée dans `extensionDependencies`.
L'API de `vscode.git` seule ne suffit pas : elle n'expose ni blame, ni rebase, ni log complet pour le graphe.
Les bibliothèques JS (`isomorphic-git`, `simple-git`) n'apportent rien de plus.

### 3.2 Arborescence

```
packages/git-forge/
  src/
    extension.ts          activation, enregistrement des fonctions activées
    git/
      runner.ts           exécution de git, file d'attente, annulation, timeout
      repos.ts            dépôts ouverts (événements vscode.git), dépôt d'un fichier donné
      parsers/            blame-porcelain, log (format à séparateurs), status porcelain v2,
                          diff --name-status, stash, worktree
      cache.ts            cache LRU par (dépôt, commit, fichier), invalidé quand HEAD ou l'index change
      commands.ts         API typée : blame(), log(), show(), merge(), pull(), rebase()…
    features/
      blame/  history/  conflicts/  merge/  compare/  graph/  operations/
    shared/               fournisseur de révisions `git-forge:`, dates relatives, l10n
  l10n/  package.nls.json  package.nls.fr.json  media/  scripts/  test/
```

### 3.3 Principes

- `features/*` n'exécute jamais `git` directement : tout passe par `git/commands.ts`. Les fonctions se
  testent avec un faux `commands`, et `git/` se teste contre de vrais dépôts.
- Une fonction = un dossier = un réglage `gitForge.<fonction>.enabled`. Une fonction désactivée
  n'enregistre ni vue, ni écouteur, ni commande.
- Le contenu d'une révision est servi par un `TextDocumentContentProvider` sous le schéma `git-forge:`
  (URI : dépôt, chemin, SHA). Il est utilisé par l'historique, la comparaison et le graphe.
- Activation `onStartupFinished` ; rien n'est enregistré tant qu'aucun dépôt n'est ouvert.
- TypeScript, bundle esbuild, conventions de PHP Forge (scripts `build`, `typecheck`, `test`).
- Textes en anglais avec traduction française : `package.nls.fr.json` et `l10n/bundle.l10n.fr.json`.
- FTP SFTP Deploy est utilisé via son API publique, uniquement s'il est installé (comme Changed Files
  Explorer).

## 4. Fonctionnalités

### 4.1 Blame (0.1)

- **Fin de ligne** : sur la ligne du curseur uniquement, texte grisé `Auteur, il y a 3 jours • message`,
  affiché après 150 ms d'inactivité du curseur. Format réglable (`gitForge.blame.format`). Lignes non
  commitées : `Vous • Modification non commitée`.
- **Survol** de la décoration : SHA, auteur, e-mail, date complète, message complet ; liens « Comparer avec
  la révision précédente », « Ouvrir le fichier à ce commit », « Copier le SHA ».
- **Barre d'état** : auteur et date relative de la ligne courante. Clic : ouvre l'historique de la ligne
  (0.2) ; en 0.1, affiche le survol.
- **Blame du fichier entier** (commande bascule) : marge à gauche, auteur et date par bloc de commits,
  couleur selon l'âge du commit.
- **Données** : `git blame --porcelain --incremental --contents -` avec le contenu de l'éditeur, ce qui
  reste juste avant l'enregistrement. Cache par (fichier, HEAD), recalcul à l'enregistrement et au
  changement de HEAD. La requête en cours est annulée quand le curseur change de fichier.
- **Ignorés** : fichiers hors dépôt, binaires, et fichiers de plus de `gitForge.blame.maxLines` lignes
  (défaut 20 000).

### 4.2 Historique (0.2)

- **Vue « Historique du fichier »** dans le panneau Source Control. Elle suit l'éditeur actif, sauf si on
  l'épingle.
- Un commit = message, auteur, date ; dépliable en liste des fichiers modifiés par ce commit.
- Pagination par 50 commits, renommages suivis (`git log --follow`).
- **Historique d'une sélection** : `git log -L début,fin:fichier`, affiché dans la même vue (« lignes
  12–30 »).
- Clic sur un commit : diff entre la révision précédente et cette révision.
- Menu contextuel : ouvrir le fichier à cette révision, comparer avec le fichier actuel, copier le SHA ou le
  message. Les opérations de la 0.6 s'y ajoutent.

### 4.3 Conflits (0.3)

Vue « Conflits » dans le panneau Source Control, visible seulement quand un merge, un rebase, un
cherry-pick ou un pop de stash est en cours avec des conflits.

- **En-tête** : opération en cours (« Merge de `feature/x` dans `main` ») et nombre de fichiers restants.
- **Fichiers en conflit**, chacun dépliable en blocs (« Conflit 1, lignes 40–52 »). Les blocs sont lus
  depuis les marqueurs `<<<<<<<` / `=======` / `>>>>>>>` (et `|||||||` en style diff3) ; la vue se met à
  jour à chaque modification du fichier.
- **Clic sur un bloc** : ouvre le fichier sur ce bloc.
- **Actions sur un bloc** : Garder le mien, Garder le leur, Garder les deux (le mien puis le leur).
- **Actions sur un fichier** : tout garder du mien, tout garder du leur, ouvrir l'éditeur 3 voies de
  VS Code, marquer comme résolu (`git add`, refusé s'il reste des marqueurs).
- **Cas particuliers** : supprimé d'un côté et modifié de l'autre → garder le fichier ou le supprimer ;
  fichier binaire → choisir une version entière (`git checkout --ours/--theirs`).
- **Actions globales** : Terminer (commit du merge, ou `rebase --continue` / `cherry-pick --continue`,
  `stash drop` après un pop réussi) ; Abandonner (`--abort`, après confirmation).

### 4.4 Merger en local (0.3)

Commande accessible par la palette et par un bouton dans la barre de titre Source Control.

1. **Choix** : branche source (liste des branches locales) ; la cible est la branche courante, et on peut
   en choisir une autre (checkout de la cible).
2. **Options** (dans le même sélecteur, mémorisées) : supprimer la branche source après le merge (non /
   en local / en local et sur le remote) ; forcer un merge commit (`--no-ff`).
3. **Préparation**
   - Arbre de travail modifié → refus, avec la proposition de mettre les modifications en stash.
   - `git fetch` ; mise à jour de la **cible** par `git pull --ff-only` ; mise à jour de la **source**
     depuis son upstream si elle en a un (fast-forward uniquement, sans checkout :
     `git fetch <remote> <branche-distante>:<branche-locale>`, qui refuse tout ce qui n'est pas un
     fast-forward).
   - Une mise à jour impossible (branches divergentes) arrête tout avec un message clair, sans rien
     modifier.
4. **Merge** : `git merge [--no-ff] <source>`.
   - Conflits → la vue Conflits s'ouvre ; la suppression de branche demandée a lieu après « Terminer ».
   - Sans conflit → suppression de la branche si demandée (`git branch -d`, puis
     `git push <remote> --delete <branche>` si « sur le remote »), puis notification « Pousser ».

### 4.5 Comparaison, stash, worktrees (0.4)

Vue « Git Forge » avec trois sections.

- **Comparer** : deux références au choix (branche, tag, commit, arbre de travail), en mode ancêtre commun
  (`A...B`, défaut) ou direct (`A..B`). Liste des commits et arbre des fichiers modifiés (A/M/D/R) ; clic
  sur un fichier = diff. Bouton **Déployer ces fichiers** via FTP SFTP Deploy (si installé) ; les fichiers
  supprimés sont signalés et non envoyés.
- **Stash** : liste des stashs et de leurs fichiers ; appliquer, pop, supprimer (après confirmation),
  comparer un fichier.
- **Worktrees** : liste ; créer depuis une branche, ouvrir dans une nouvelle fenêtre, supprimer (après
  confirmation).

### 4.6 Graphe de commits (0.5)

Webview dans un panneau éditeur.

- **Données** : `git log --all --topo-order` (SHA, parents, refs, auteur, date, message), par pages de
  500 commits.
- **Placement** : l'attribution des colonnes et des lignes de liaison est calculée dans l'extension par un
  module pur, testé unitairement. La webview ne fait que dessiner.
- **Rendu** : SVG virtualisé (seules les lignes visibles sont rendues), pour rester fluide sur 50 000
  commits.
- **Colonnes** : graphe, branches/tags, message, auteur, date. HEAD et les branches distantes sont mis en
  évidence.
- **Recherche** par message, auteur ou SHA ; filtre « branche courante seulement ».
- **Clic sur un commit** : détails et fichiers ; double-clic sur un fichier : diff.
- **Menu d'un commit** : checkout, créer une branche ou un tag, comparer avec HEAD ou avec la sélection,
  opérations de la 0.6.
- **Menu d'une branche** : checkout, Merger en local (§4.4), supprimer.

### 4.7 Opérations guidées (0.6)

Accessibles depuis le graphe et l'historique. Toute opération destructive affiche ce qui va se passer
avant de le faire.

- **Cherry-pick** et **revert** : confirmation qui récapitule le commit ; conflits → vue Conflits.
- **Reset** : choix soft / mixed / hard, chacun expliqué en une phrase. Pour `hard`, une deuxième
  confirmation liste les fichiers modifiés qui seront perdus, et un tag de sauvegarde
  `git-forge/backup/<date>` est créé sur HEAD avant le reset.
- **Rebase interactif** : éditeur dédié (webview) listant les commits ; réordonner par glisser-déposer,
  choisir pick / reword / squash / fixup / drop, modifier les messages sur place. Exécution par
  `git rebase -i`, avec `GIT_SEQUENCE_EDITOR` et `GIT_EDITOR` pointant vers un script de l'extension qui
  écrit la liste et les messages préparés. Conflits → vue Conflits.
- **Réglage `gitForge.rebaseEditor`** (désactivé par défaut) : ouvre ce même éditeur quand l'utilisateur
  lance `git rebase -i` lui-même dans le terminal intégré.

## 5. Réglages et commandes

Préfixe `gitForge.`. Réglages : `<fonction>.enabled` pour `blame`, `history`, `conflicts`, `merge`,
`compare`, `graph`, `operations` (tous activés par défaut), `blame.format`, `blame.maxLines`,
`blame.statusBar`, `rebaseEditor`. Commandes : `gitForge.toggleFileBlame`, `gitForge.showFileHistory`,
`gitForge.showLineHistory`, `gitForge.mergeLocal`, `gitForge.compareReferences`, `gitForge.showGraph`,
`gitForge.cherryPick`, `gitForge.revert`, `gitForge.reset`, `gitForge.interactiveRebase`.

## 6. Gestion des erreurs

- Si `git` est absent ou si `vscode.git` est désactivé : extension inactive, un seul message, une fois.
- Les erreurs de `git` sont traduites en messages clairs (branche divergente, arbre de travail modifié,
  verrou `index.lock`, authentification refusée…) ; la sortie brute va dans le canal de sortie
  « Git Forge ».
- Fetch, pull et push utilisent les identifiants de l'utilisateur via le `GIT_ASKPASS` de `vscode.git`
  s'il est disponible ; sinon, le message invite à lancer la commande dans le terminal.
- Une opération en échec ne laisse jamais le dépôt dans un état intermédiaire caché : un merge, un rebase
  ou un cherry-pick en cours est toujours visible dans la vue Conflits.

## 7. Performances

- Écritures : une seule commande `git` à la fois par dépôt. Lectures : 4 en parallèle au maximum.
- Requêtes de blame annulées quand le curseur change de fichier ; cache LRU borné.
- Les fonctions désactivées ne coûtent rien.
- **Objectifs** (mesurés en e2e) : blame de la ligne courante en moins de 100 ms une fois le cache chaud ;
  première page du graphe en moins de 500 ms sur un dépôt de 10 000 commits.

## 8. Tests

- **Parseurs** : tests unitaires `node --test` sur des sorties réelles de `git` enregistrées comme
  fixtures. Cas limites : noms avec espaces ou accents, renommages, commit racine, merges, binaires,
  sous-modules.
- **`git/commands`** : tests contre de vrais dépôts temporaires créés par un helper `makeRepo()` (commits,
  branches et conflits programmés). Merge local, conflits et rebase y sont testés de bout en bout côté Git.
- **Placement du graphe** : historiques construits (branches parallèles, merges octopus, branches
  orphelines).
- **e2e** dans un vrai VS Code (sur le modèle de PHP Forge) : activation, blame affiché, vue Conflits
  peuplée après un merge en conflit, commande Merger en local.
- **Traductions** : `test/l10n.test.js` étendu à Git Forge.
- Développement en TDD pour tout le code non-UI.
