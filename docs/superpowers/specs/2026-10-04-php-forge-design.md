# PHP Forge — spécification de conception

- **Date** : 2026-10-04
- **Statut** : validée en conversation (sections 1 à 4), spec écrite
- **Extension** : `yuval-abdm.php-forge`, nom affiché « PHP Forge »
- **Emplacement** : `packages/php-forge/` du monorepo `vscode-extensions`
- **Licence** : MIT (stubs PhpStorm sous Apache 2.0, attribution dans `NOTICE`)

## 1. Objectif

Un serveur de langage PHP **gratuit et complet**, publié sur le VS Code Marketplace et Open VSX, qui
remplace Intelephense (gratuit **et** premium) et va plus loin sur le code PHP « historique » :

- projets sans Composer ni namespaces, structurés par `include` / `require` ;
- variables, fonctions et classes qui circulent d'un fichier à l'autre par inclusion ;
- `extract($_POST)`, `global`, constantes de chemin (`ROOT_PATH`), SQL écrit à la main dans des chaînes.

**Critère de succès** : sur les projets réels de l'auteur (les 9 `CRM-*`, `les-maisons-de-retraite.com`),
PHP Forge remplace Intelephense au quotidien, signale de vrais bugs (variable manquante quand un fichier
est inclus depuis une page précise, symbole non inclus, injection SQL…) avec peu de fausses alertes, et
reste fluide sur 3 000+ fichiers.

### Projets de référence (constats qui pilotent la conception)

| Constat (CRM-FR, ~3 200 fichiers PHP, 67 Mo) | Réponse de la conception |
|---|---|
| ~4 000 `include_once(ROOT_PATH.'/…')`, `define('ROOT_PATH', $_SERVER['DOCUMENT_ROOT'])` | Évaluation symbolique des chaînes et des constantes, propagée par les inclusions (§4.1) |
| `require_once dirname(dirname(__FILE__)) . '/…'` | `dirname()`, `__DIR__`, `__FILE__` évalués exactement |
| `include_once '/home/…/public_html/x.php'` (chemins serveur) | `phpForge.serverRoot`, ou lu dans `.vscode/deploy.json` (FTP SFTP Deploy) |
| ~90 `extract($_POST…)`, 60 `extract($arrRow)` | Variables « venant de la requête » / « dynamiques » au lieu de couper l'analyse (§4.4) |
| Classes sans namespace chargées par `include` | Règle « symbole non inclus » + action « ajouter l'include » |
| `mysql_query`, `error_reporting(E_ALL ^ E_NOTICE)` | Diagnostics par version PHP, **baseline** des alertes existantes |
| `PHPExcel/`, `vendor/`, librairie Google Ads (~1,8 M lignes au total) | Mode « librairie » : indexé, jamais diagnostiqué |
| Sites qui incluent l'init du CRM (`$fromWebsite`, `$rootPathCRM`) | `phpForge.externalGlobals` et `/** @var */` en tête de fichier |

Mesure faite : tree-sitter-php (WASM) analyse les 3 236 fichiers de CRM-FR en 6,2 s sur un seul thread.

## 2. Périmètre de la v1.0

Tout ce qui suit est dans la 1.0, livré par jalons (§8). Rien n'est reporté à une v2.

1. **Navigation** : complétion, définition / type / implémentation, survol, aide aux paramètres,
   symboles du document et du workspace, indications inline (inlay hints).
2. **Diagnostics** : syntaxe, symboles inconnus, variables non définies avec la règle stricte par appelant,
   nombre d'arguments, `use` inutilisés, code mort, API supprimées / dépréciées selon `phpVersion`.
3. **Refactorings** : renommer, références, CodeLens, imports automatiques et proposés (`use` et `include`),
   organisation des `use`, génération (getters/setters, constructeur, méthodes d'interface, phpdoc).
4. **Formatage** : PSR-12 configurable, fichiers mixtes HTML/PHP.
5. **SQL** : coloration, analyse, complétion et vérification des tables / colonnes depuis le schéma.
6. **Sécurité** : suivi des données utilisateur jusqu'aux points sensibles (SQL, HTML, shell, include).
7. **Migration** : rapport et corrections rapides pour passer d'une version PHP à une autre.
8. **Intégration FTP SFTP Deploy** : pages impactées par une modification, déploiement en un clic.

Hors périmètre : débogueur (Xdebug a son extension), exécution de tests PHPUnit, frameworks spécifiques
(Laravel, Symfony) au-delà du PHP standard et de PSR-4.

## 3. Architecture

```
packages/php-forge/
  package.json            manifeste VS Code (contributions, réglages, commandes)
  src/
    client/               extension VS Code : démarre le serveur, réglages, commandes, barre d'état
    server/
      server.ts           point d'entrée LSP (vscode-languageserver), routage des requêtes
      parser/             tree-sitter-php WASM : analyse et ré-analyse incrémentale des documents ouverts
      model/              arbre syntaxique → symboles PHP (classes, fonctions, variables, use, include…)
      index/              index du workspace, références, cache disque, indexation en worker threads
      types/              inférence de types (phpdoc, signatures, flux, instanceof, assert)
      includes/           résolution des chemins, graphe d'inclusion, résumés et flux des variables
      features/           un module par fonctionnalité LSP (completion, hover, definition, …)
      diagnostics/        règles, suppressions, baseline
      sql/                détection, analyse, schéma, fonctionnalités SQL
      security/           analyse de propagation (sources → puits)
      format/             formateur à base de jetons
      stubs/              chargement de l'index des fonctions natives
    shared/               types et constantes partagés client / serveur
  stubs/                  index des fonctions natives généré au build depuis JetBrains/phpstorm-stubs
  syntaxes/               grammaire d'injection TextMate pour le SQL dans les chaînes PHP
  l10n/, package.nls*.json   anglais + français (comme les autres extensions du monorepo)
  test/                   unitaires, fixtures, e2e
  scripts/                génération des stubs, banc d'essai sur corpus réel
```

### Principes

- **Langage** : TypeScript, `strict`, syntaxe effaçable uniquement (`erasableSyntaxOnly`) pour que Node
  exécute les tests directement ; bundle esbuild (`dist/client.js`, `dist/server.js`, `dist/worker.js`)
  comme les autres extensions. Commentaires en français, textes d'interface en anglais + traduction FR.
- **Couches étanches** : `features/` ne manipule jamais l'arbre tree-sitter ; il passe par `model/`,
  `index/`, `types/`, `includes/`. On peut changer d'analyseur sans toucher aux fonctionnalités.
- **Serveur LSP standard** (stdio / IPC) : réutilisable dans d'autres éditeurs.
- **Indexation en deux temps** : passe rapide (déclarations, `include`, `define`) au démarrage dans un
  pool de worker threads (cœurs − 1) ; inférence fine à la demande, mise en cache.
- **Mémoire** : arbres conservés uniquement pour les documents ouverts ; le reste du projet est réduit à
  des résumés sérialisables.
- **Cache disque** dans le `globalStorage` de VS Code, par workspace, invalidé par fichier (taille, date,
  hash du contenu) et par version du format de cache.
- **Encodage** : UTF-8 si valide, sinon Windows-1252 (fichiers historiques Latin-1).
- **Stubs** : `JetBrains/phpstorm-stubs` (tag figé), compilés au build en un index compact. Disponibilité
  par version (`#[PhpStormStubsElementAvailable]`, `@since`, `@removed`, `@deprecated`) et par extension PHP.
- **Cohabitation** : si Intelephense ou PHP Tools est actif, proposer de le désactiver pour ce workspace
  (doublons de complétion et de diagnostics sinon).

### Performances visées (CRM-FR, machine de dev)

| Mesure | Cible |
|---|---|
| Première indexation (arrière-plan, complétion du fichier ouvert disponible immédiatement) | < 30 s |
| Réouverture avec cache | < 3 s |
| Diagnostics du fichier courant après frappe | < 150 ms |
| Complétion | < 100 ms |
| Mémoire du serveur | < 1,5 Go |

## 4. Moteur d'inclusion et analyse des variables

### 4.1 Évaluation symbolique des chaînes

Une valeur de chemin est une suite de segments : littéral, `DOCROOT`, `DIR(fichier)`, `INCONNU`.
On évalue : littéraux, concaténation, interpolation simple, `__DIR__`, `__FILE__`, `dirname(x[, n])`,
`$_SERVER['DOCUMENT_ROOT']`, `realpath()` (identité), constantes définies par `define()` / `const`, et
variables locales assignées une seule fois avant usage. Les constantes et variables traversent les
inclusions comme les autres symboles (`ROOT_PATH` défini dans `rp_appInit.php` est connu des fichiers
inclus ensuite).

### 4.2 Résolution des chemins

| Forme | Résolution |
|---|---|
| Relatif (`'includes/x.php'`) | Comme PHP : dossier du **script d'entrée** de la chaîne, puis dossier du fichier appelant |
| `__DIR__`, `dirname(__FILE__)` | Exacte |
| `DOCROOT` | `phpForge.documentRoot` (défaut : racine du workspace) |
| Chemin absolu serveur | `phpForge.serverRoot` → racine locale ; à défaut, `remotePath` de `.vscode/deploy.json` |
| Dynamique / inconnu | Non résolu : diagnostic `unresolved-include` (information) ; indice `/** @include chemin */` sur la ligne précédente |

Un chemin relatif dans un fichier inclus dépend du script d'entrée : la résolution est faite **par chaîne
d'appel**. Si plusieurs cibles sont possibles selon les chaînes, l'inclusion a plusieurs cibles.

### 4.3 Graphe d'inclusion

Nœuds = fichiers ; arêtes = sites d'inclusion (fichier, position, cibles, `_once`, inclusion dans une
fonction ou au niveau global, certaine ou conditionnelle). Scripts d'entrée = fichiers que personne
n'inclut. Les cycles sont détectés ; `include_once` / `require_once` coupent la ré-entrée comme PHP.

### 4.4 Résumé par fichier

Pour chaque portée (niveau fichier, chaque fonction), une liste ordonnée d'événements, sérialisable :

- `assign(var, certain|peut-être, type)` — y compris `list()`, `foreach`, `catch`, référence `&`, `static`, `global` ;
- `read(var, position)` ;
- `include(site)` ;
- `unset(var)` ;
- `extract(source)` avec `source` ∈ { requête (`$_GET`/`$_POST`/`$_REQUEST`/`$_COOKIE`),
  tableau littéral (clés connues), autre } ;
- `dynamique` (`$$x`, `get_defined_vars()`, `eval`, `parse_str` sans 2ᵉ argument).

Les branches (`if`, `switch`, `try`, boucles, `?:`, `??=`) produisent des assignations « peut-être ».
Les superglobales et `$this` (dans une méthode) sont toujours définies.

### 4.5 Flux entre fichiers et règle stricte

- **Vers le bas** : le contexte d'entrée d'un fichier inclus = variables définies (certaines / peut-être)
  chez l'appelant **au point d'inclusion**, contexte de l'appelant compris. Une inclusion à l'intérieur
  d'une fonction hérite de la portée locale de cette fonction.
- **Vers le haut** : après l'inclusion, l'appelant reçoit les variables (et types, constantes, fonctions,
  classes) définies par le fichier inclus.
- **Contextes** : chaque chaîne depuis un script d'entrée produit un contexte. Évaluation mémorisée par
  (fichier, empreinte de l'ensemble d'entrée) ; profondeur et nombre de contextes plafonnés
  (`phpForge.includes.maxContexts`, défaut 64 par fichier ; au-delà, union des contextes et diagnostic
  « analyse approximative » en information).
- **Règle stricte** : une lecture est signalée dès qu'**un** contexte ne définit pas la variable, avec la
  liste des appelants fautifs :
  `$annonce_id is not defined when included from lp_3/index.php:12, landing_v6/index.php:40 (defined in 14 other callers)`.
  Un fichier jamais inclus est analysé seul.
- **Peut-être non définie** : `maybe-undefined-variable`, niveau réglable (défaut : information).
- **`extract` d'une requête** : une variable inconnue lue ensuite n'est pas signalée ; le survol indique
  `$nom ← $_POST via extract (ligne 12)` ; elle est marquée « source utilisateur » pour l'analyse de
  sécurité. **`extract` d'un tableau littéral** : clés connues définies. **Autre `extract` / dynamique** :
  plus d'alerte de variable non définie dans la portée à partir de ce point.
- **Après une inclusion non résolue** : plus d'alerte de variable non définie dans la portée.
- **Variables externes** : `phpForge.externalGlobals` (liste de noms, éventuellement typés) et
  `/** @var Type $nom */` en tête de fichier.

### 4.6 Fonctions, classes et constantes entre fichiers

Dans un projet sans autoload, un symbole utilisé doit être déclaré dans un fichier atteint par la chaîne
d'inclusion (en amont ou en aval avant le point d'usage), sinon `symbol-not-included` avec la même
précision par appelant. Désactivé automatiquement pour les classes couvertes par un autoload Composer
(PSR-4 / PSR-0 / classmap / files lus dans `composer.json`) ou un `spl_autoload_register` détecté.

### 4.7 Interface

- CodeLens en tête de fichier : « Included by N files » → liste des appelants.
- Survol d'une variable : origine (`defined in landing.php:8`, type).
- Vue « Include tree » (appelants et inclus, récursif) et commande « Show include tree ».

## 5. Fonctionnalités

### 5.1 Navigation

- **Complétion** : variables (y compris issues des appelants), membres selon le type, fonctions natives
  filtrées par `phpVersion` et extensions, classes / interfaces / traits / enums, constantes, mots-clés,
  clés de tableaux connues (shapes), chemins de fichiers dans les `include`, noms de tables / colonnes SQL,
  balises phpdoc. Résolution différée (`completionItem/resolve`) pour la documentation.
- **Définition, déclaration de type, implémentation** (interfaces, méthodes abstraites, surcharges),
  y compris depuis une chaîne `include` vers le fichier.
- **Survol** : signature, phpdoc rendu en Markdown, type inféré, origine de la variable, lien vers la doc
  php.net pour les fonctions natives.
- **Aide aux paramètres**, **symboles du document** (hiérarchie), **symboles du workspace** (recherche floue).
- **Inlay hints** : noms de paramètres sur les arguments littéraux (défaut activé, comme PhpStorm), types
  des variables et types de retour (désactivés par défaut).
- **Surbrillance** des occurrences, **plages de repli**, **sélection intelligente**, **tokens sémantiques**.

### 5.2 Inférence de types

Types : scalaires, `null`, `mixed`, `void`, `never`, classes, unions, intersections, nullable, tableaux
`T[]`, `array<K,V>`, `list<T>`, formes `array{clé: T}`, `callable`, `iterable`, `static`/`self`/`$this`,
génériques `@template` simples. Sources : déclarations, phpdoc (`@var`, `@param`, `@return`, `@property`,
`@method`, `@mixin`), valeurs littérales, `new`, retours de fonctions / méthodes, stubs, rétrécissement
(`instanceof`, `is_*`, `!== null`, `assert`), `foreach`, fonctions de tableau usuelles. Types inférés
transmis par les inclusions (un `$pdo` défini dans `connexion_DB.php` est un `PDO` dans les pages).

### 5.3 Diagnostics

| Code | Défaut | Description |
|---|---|---|
| `syntax-error` | erreur | Erreur d'analyse tree-sitter |
| `undefined-variable` | avertissement | Règle stricte §4.5 |
| `maybe-undefined-variable` | information | Définie seulement dans une branche |
| `undefined-function` / `undefined-class` / `undefined-constant` | erreur | Symbole introuvable |
| `undefined-method` / `undefined-property` | avertissement | Sur un type connu (pas sur `mixed`, ni avec `__call` / `__get`) |
| `symbol-not-included` | avertissement | §4.6 |
| `argument-count` | erreur | Trop / pas assez d'arguments |
| `unused-use` | indice (grisé) | `use` non utilisé |
| `unreachable-code` | indice (grisé) | Après `return`, `throw`, `exit`, `die` |
| `unresolved-include` | information | §4.2 |
| `removed-api` / `deprecated-api` | erreur / avertissement | Selon `phpVersion` (stubs) |
| `deprecated-syntax` | avertissement | Syntaxe dépréciée ou supprimée selon `phpVersion` |
| `duplicate-declaration` | erreur | Fonction / classe déclarée deux fois dans une même chaîne |
| `sql-*` | voir §5.6 | |
| `security-*` | voir §5.7 | |

- Niveau réglable par règle : `phpForge.diagnostics.rules.<code>` = `error|warning|information|hint|off`.
- Suppression : `// @php-forge-ignore <code>` sur la ligne ou la ligne précédente ;
  `/** @php-forge-ignore-file <code> */` pour le fichier.
- **Baseline** : commande « Create baseline » → `.vscode/php-forge-baseline.json` ; clé = fichier + code +
  hash du message + hash du texte de la ligne (robuste aux décalages de lignes). Seules les nouvelles
  alertes s'affichent. Commandes « Update baseline » et « Clear baseline ». Compteur des alertes
  masquées dans la barre d'état.
- Dossiers librairie (`phpForge.libraryPaths`, défaut : `vendor/**`, dossiers contenant un `composer.json`
  tiers, `**/PHPExcel/**`, `**/Google/Api/**`) : indexés, jamais diagnostiqués.
- `phpForge.exclude` : ni indexés ni diagnostiqués.
- Diagnostics de workspace : fichiers ouverts en priorité, puis tout le projet en arrière-plan
  (`phpForge.diagnostics.scope` = `openFiles|workspace`, défaut `workspace`).

### 5.4 Refactorings et imports

- **Renommer** (variable — y compris à travers les inclusions —, paramètre, fonction, classe, méthode,
  propriété, constante, namespace) avec `prepareRename` qui refuse les symboles natifs et les librairies.
- **Références** (y compris dans les chaînes `'Classe::methode'` et callables `[$obj, 'm']` quand c'est
  sûr), **CodeLens** « N references » / « N implementations ».
- **Import automatique** : accepter une classe / fonction / constante en complétion ajoute le `use`, trié.
- **Import proposé** (action rapide) sur nom inconnu : candidats du projet, de Composer et des stubs ;
  « Import all missing ». Code sans namespace : « Add include 'includes/fonctions.php' » avec le chemin
  écrit dans le style dominant du fichier (`ROOT_PATH.'/…'`, `__DIR__`, relatif).
- **Organiser les `use`** (trier, grouper, supprimer les inutilisés), aussi à la sauvegarde (option).
- **Génération** : getters / setters, constructeur (avec promotion de propriétés si `phpVersion` ≥ 8.0),
  méthodes manquantes d'une interface / classe abstraite, squelette phpdoc, `@var` pour une variable.
- **Corrections rapides** liées aux diagnostics (déclarer la variable, ajouter `use`, ajouter l'include,
  remplacer une API supprimée, ignorer la règle sur la ligne / le fichier).

### 5.5 Formatage

Formateur à base de **jetons** (pas de réimpression complète de l'arbre) : il corrige indentation,
espaces et accolades sans réécrire la structure, ce qui le rend sûr sur les fichiers mixtes HTML/PHP.

- PSR-12 par défaut ; réglages : style d'accolades, taille d'indentation (depuis l'éditeur), alignement des
  `=>` et des `=` consécutifs, virgule finale dans les tableaux multilignes, longueur de ligne indicative.
- Document, sélection, à la frappe (`;`, `}`) et à la sauvegarde (réglage VS Code standard).
- Fichiers mixtes : seuls les blocs `<?php … ?>` sont reformatés ; l'indentation de base du bloc suit
  celle du HTML qui l'entoure. `<?= … ?>` est seulement normalisé en espaces.
- Garanties testées : idempotent (formater deux fois = formater une fois) ; jetons non blancs inchangés.

### 5.6 SQL dans les chaînes

- **Détection** : chaînes passées à `query`, `prepare`, `exec`, `mysql_query`, `mysqli_query`,
  `mysqli::query`, `PDO::query/prepare/exec`, `pg_query`… et chaînes commençant par
  `SELECT|INSERT|UPDATE|DELETE|REPLACE|WITH|CREATE|ALTER`. Concaténations et interpolations remplacées par
  des emplacements typés pour l'analyse. Indice `/** @sql */` pour forcer.
- **Coloration** : grammaire d'injection TextMate (`syntaxes/`) pour les chaînes détectables
  syntaxiquement, complétée par des tokens sémantiques.
- **Schéma** : source réglable `phpForge.sql.schema` :
  1. fichiers `.sql` (`CREATE TABLE`) — défaut : `sql/**/*.sql`, `migrations/**/*.sql` ;
  2. connexion MySQL / MariaDB en lecture seule (`INFORMATION_SCHEMA`) déclenchée par la commande
     « Refresh SQL schema », mot de passe dans le `SecretStorage` de VS Code, résultat mis en cache dans
     `.vscode/php-forge-schema.json`.
- **Fonctionnalités** : complétion des tables, colonnes (selon les alias du `FROM`), fonctions SQL ;
  survol d'une colonne (type, NULL, défaut) ; aller à la définition vers le `CREATE TABLE` ;
  diagnostics `sql-syntax` (avertissement), `sql-unknown-table` / `sql-unknown-column` (avertissement,
  seulement si un schéma est chargé) ; clés de `fetch_assoc()` / `fetch(PDO::FETCH_ASSOC)` typées par les
  colonnes du `SELECT` (complétion de `$row['…']`, et `extract($row)` connaît alors ses clés).
- Dialecte : MySQL / MariaDB (celui des projets de référence) ; analyseur SQL tolérant (bibliothèque MIT /
  Apache, choisie au jalon 0.7 après essai sur le corpus).

### 5.7 Sécurité (analyse de propagation)

- **Sources** : superglobales de requête, `extract` d'une requête, `php://input`, `getenv` (option),
  paramètres de fonctions appelées avec une source (inter-procédural sur les résumés, profondeur bornée).
- **Puits** : SQL (`security-sql-injection`), sortie HTML `echo` / `print` / `<?=` (`security-xss`),
  commandes (`exec`, `system`, `shell_exec`, backticks, `passthru`, `proc_open` — `security-command-injection`),
  inclusion (`security-file-inclusion`), `unserialize` (`security-unsafe-unserialize`), `header('Location: …')`
  (`security-open-redirect`), écriture de fichier avec chemin contrôlé (`security-path-traversal`).
- **Neutraliseurs** selon le puits : casts `(int)`/`(float)`, `intval`, `filter_var`/`filter_input`,
  `htmlspecialchars`/`htmlentities` (HTML), `mysqli_real_escape_string`/`addslashes` dans une chaîne
  entre quotes (SQL), requêtes préparées avec paramètres liés, `escapeshellarg`, `basename` (chemins),
  `in_array(…, true)` sur liste littérale (rétrécissement). Neutraliseurs personnalisés :
  `phpForge.security.sanitizers`.
- Message avec le chemin de propagation : `$_POST['id'] (ligne 12) → $id → $sql (ligne 20) → mysqli_query (ligne 21)`.
- Niveau : avertissement par défaut ; `phpForge.security.enabled`.

### 5.8 Migration de version PHP

- `phpForge.phpVersion` (défaut : `require.php` de `composer.json`, sinon `php -v` détecté, sinon 8.3) et
  `phpForge.migration.targetVersion` (option).
- Avec une cible : diagnostics `migration-*` pour tout ce qui casse entre la version actuelle et la cible —
  API supprimées (`mysql_*`, `each`, `create_function`, `split`, `ereg*`…), syntaxe (`$s{0}`, cast `(real)`,
  `${var}` dans les chaînes, paramètres implicitement nullables, propriétés dynamiques, constructeurs
  PHP 4, ternaires imbriqués sans parenthèses…), changements de comportement documentés (comparaisons
  chaîne / nombre en 8.0…).
- Corrections rapides quand la transformation est sûre (`each` → `foreach`, `$s{0}` → `$s[0]`, `(real)` →
  `(float)`, `create_function` → closure simple, constructeur PHP 4 → `__construct`).
- Commande « Migration report » : rapport Markdown par règle et par fichier, avec compteurs.

### 5.9 Intégration FTP SFTP Deploy

Via l'API publique de `yuval-abdm.ftp-sftp-deploy` (déjà utilisée par Changed Files Explorer), seulement
si elle est installée :

- `serverRoot` déduit de `deploy.json` (§4.2) ;
- vue / commande « Impact » : pour les fichiers modifiés (git ou non enregistrés), les scripts d'entrée
  qui les atteignent par inclusion — la liste des pages à vérifier ;
- « Deploy changed files » depuis cette vue, et avertissement avant déploiement si un fichier déployé
  contient des diagnostics de niveau erreur (désactivable).

## 6. Réglages et commandes (préfixe `phpForge.`)

Réglages : `phpVersion`, `documentRoot`, `serverRoot`, `libraryPaths`, `exclude`, `externalGlobals`,
`includes.maxContexts`, `diagnostics.scope`, `diagnostics.rules.*`, `baseline.path`, `inlayHints.parameterNames`,
`inlayHints.variableTypes`, `inlayHints.returnTypes`, `completion.autoImport`, `format.*`, `sql.schema`,
`sql.connection`, `security.enabled`, `security.sanitizers`, `migration.targetVersion`, `trace.server`.

Commandes : Restart server, Reindex workspace, Show include tree, Create / Update / Clear baseline,
Refresh SQL schema, Migration report, Show impacted pages, Import all missing, Organize uses,
Generate (getters/setters, constructor, implement methods), Show output.

Barre d'état : version PHP active, état de l'indexation (progression), alertes masquées par la baseline.

## 7. Gestion des erreurs

- Le serveur ne doit jamais faire tomber l'éditeur : chaque requête est isolée ; une exception est
  journalisée (canal « PHP Forge ») et renvoie un résultat vide.
- Redémarrage automatique du serveur par le client (3 fois en 3 minutes, puis notification avec
  « Restart » et « Show output »).
- Fichier illisible, trop gros (`phpForge.maxFileSize`, défaut 2 Mo) ou binaire : ignoré, journalisé.
- Cache corrompu ou de format différent : supprimé et reconstruit sans intervention.
- Échec de connexion SQL : notification non bloquante, ancien schéma conservé.
- Toute fonctionnalité dépendant d'une analyse incomplète (indexation en cours) répond avec ce qui est
  connu, sans bloquer ; les diagnostics inter-fichiers attendent la fin de la passe rapide.

## 8. Jalons

Chaque jalon a son propre plan d'implémentation, est publiable en préversion et est utilisé sur les
projets réels avant de passer au suivant.

| Version | Contenu |
|---|---|
| 0.1 Fondations | Package, client + serveur LSP, analyse tree-sitter, modèle, index du workspace (workers + cache), stubs ; symboles du document / workspace, aller à la définition, survol minimal, erreurs de syntaxe |
| 0.2 Navigation | Inférence de types, complétion, survol complet, aide aux paramètres, inlay hints, implémentation, surbrillance, repli, tokens sémantiques |
| 0.3 Moteur d'inclusion | §4 complet : évaluation symbolique, résolution, graphe, résumés, flux, CodeLens / vue des inclusions |
| 0.4 Diagnostics | §5.3 complet, suppressions, baseline, API par version |
| 0.5 Refactorings et imports | §5.4 |
| 0.6 Formatage | §5.5 |
| 0.7 SQL | §5.6 |
| 0.8 Sécurité et migration | §5.7, §5.8 |
| 0.9 Deploy | §5.9 |
| 1.0 | Performances (§3), documentation, traduction FR complète, publication Marketplace + Open VSX |

## 9. Tests

- **Unitaires** (`node --test`, TypeScript exécuté directement par Node) : par module — évaluation
  symbolique, résolution de chemins, résumés, flux, inférence, règles, formateur, SQL, propagation.
- **Fixtures** (`test/fixtures/<scénario>/`) : mini-projets fictifs qui reproduisent les cas réels
  (`legacy-includes/` avec `ROOT_PATH`, `extract($_POST)`, un fichier inclus par trois appelants dont un
  fautif ; `composer-psr4/` ; `mixed-html/` ; `sql-schema/` ; `taint/` ; `migration-php56/`).
  Les diagnostics attendus sont écrits dans les fixtures (`// expect: undefined-variable lp_3/index.php`).
- **LSP** : tests du serveur en processus via une connexion LSP en mémoire (requêtes → réponses attendues).
- **E2E** : `@vscode/test-electron` (déjà en place dans le monorepo) — activation, complétion, diagnostics,
  renommage dans un vrai VS Code.
- **Formateur** : idempotence et conservation des jetons sur toutes les fixtures et sur le corpus.
- **Corpus réel, local uniquement** : `npm run bench` avec `PHP_FORGE_CORPUS=/chemin1:/chemin2`. Mesure le
  temps d'indexation, la mémoire, les plantages et le nombre d'alertes par règle ; compare avec la mesure
  précédente (`bench-results/`, ignoré par git). **Aucun fichier du corpus n'est jamais commité** (code
  privé contenant des identifiants).
- **TDD** pour toute la logique d'analyse : cas en échec d'abord, puis code.
- **Traductions** : `test/l10n.test.js` du monorepo étendu à PHP Forge.
