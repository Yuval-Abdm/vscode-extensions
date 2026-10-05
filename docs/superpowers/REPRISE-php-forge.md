# PHP Forge — note de reprise (2026-10-05)

Note pour reprendre le travail dans une nouvelle session Claude Code (autre compte possible). Demande en cours de
l'utilisateur : **« enchaîne tout jusqu'à 1.0 »** — enchaîner les jalons 0.3 → 1.0 sans merge, sans push, sans
publication ; les commandes finales (push, merge, publication) sont données à l'utilisateur.

## Contraintes permanentes

- Répondre en français. Finir chaque tâche par le rapport « 📁 Fichiers modifiés / ✅ Fichiers créés /
  🗑️ Fichiers supprimés » (« Aucun fichier impacté » s'il n'y a rien).
- Commits **sans** `Co-Authored-By` ni mention de Claude ; auteur `Yuval-Abdm` (noreply GitHub, déjà configuré).
- **Jamais de `git push`** : donner les commandes à l'utilisateur.
- `~/dev/retraite-plus` (CRM-FR, CRM-BE…) est du **code privé avec des identifiants** : on peut le lire pour mesurer
  (bench, sondes), mais rien n'en est copié dans le dépôt. Les scripts de mesure vont dans
  `packages/php-forge/.cache/` (ignoré par git).
- Spec : `docs/superpowers/specs/2026-10-04-php-forge-design.md` (jalons au §8).
- Méthode : skills superpowers `writing-plans` (plans complets dans `docs/superpowers/plans/`) puis
  `executing-plans` (exécution inline, ledger dans `.superpowers/sdd/<plan>/progress.md`, scripts `task-start` /
  `task-done`), revue finale de la branche par un agent sur le modèle le plus capable, une passe de corrections
  RED→GREEN, rulings et mineurs différés copiés dans `.superpowers/php-forge-decisions.md`, puis suppression de
  l'espace `.superpowers/sdd/<plan>/`. Aides : `.superpowers/materialize.py PLAN chemin` (écrit un bloc
  `File:` du plan ; lancer depuis la racine du dépôt, chemin relatif au paquet).

## Commandes utiles

```bash
cd packages/php-forge && npm test                      # tests unitaires et serveur (≈ 570)
npx tsc -p .                                            # types
node ../../test/l10n.test.js                            # traductions
cd ../.. && LD_LIBRARY_PATH=$PWD/.vscode-test/libs/root/usr/lib/x86_64-linux-gnu npm run test:e2e:php-forge
cd packages/php-forge && PHP_FORGE_CORPUS=$HOME/dev/retraite-plus/CRM-FR node scripts/bench.ts   # mesure
```

## État des branches

| Branche | État |
|---|---|
| `feat/php-forge-0.4` | 0.4 Diagnostics — terminée, revue faite et corrigée |
| `feat/php-forge-0.5` | 0.5 Refactorings et imports — terminée, revue faite et corrigée |
| `feat/php-forge-0.6` | 0.6 Formatage — tâches 1-6 faites ; **passe de corrections de la revue en cours** (commit WIP `fb7b506`) |
| `wip/php-forge-0.7-sql-draft` | Brouillon 0.7 SQL (code validé, pas encore de plan) — part de 0.6 avant la passe de corrections |

Chaque branche part de la précédente (0.6 contient 0.4 et 0.5). Rien n'est mergé ni poussé.

## 0.6 — ce qui reste (passe de corrections de la revue)

Ledger : `.superpowers/sdd/2026-10-05-php-forge-0.6-formatting/progress.md`.

Faits dans le commit WIP (tests verts au dernier passage) :
- C1 `- -$b` collé en `--$b` (change le sens) → espace gardé (`spacing.ts`) ;
- I4 `return ++$i` collé → espace gardé ;
- I3 corps sans accolades (`if ($a)\n foo();`) indentés, et I7 `for (…): … endfor;`, `endswitch` (`indent.ts`) ;
- I2 virgule finale écrite dans un commentaire `// …` ou après un heredoc → corrigé (`align.ts`) ;
- I6 garanties : `test/format-helpers.ts` (`tokenStream`), comparaison de la suite des jetons dans `format.test.ts`
  et `format-fixtures.test.ts` (toutes les options, virgule finale comprise).

À finir :
- I5 formatage à la frappe : mettre en page seulement l'instruction autour du curseur. Déjà écrit :
  `onTypeWindow(tree, range)` et le paramètre `window` de `layout` / `formatEdits` (`format.ts`), `tokenOf` /
  `atomOf` / `tokensOf(nœud)` (`tokens.ts`), `Indenter` tolérant aux blocs hors fenêtre (`indent.ts`). Reste :
  le test (gros fichier de 4000 méthodes : mêmes modifications qu'en pleine page, au moins 5 fois plus rapide ;
  fenêtre = `return_statement`), puis brancher dans `server.ts` (`onDocumentOnTypeFormatting` :
  `formatEdits(…, range, onTypeWindow(tree, range))`).
- Ajouter dans le bench la comparaison de la suite des jetons (I6).
- Lancer `npm test`, l'e2e, le bench (`formatFailures` doit rester à 0), commit
  « fix(php-forge): revue 0.6 — … », lignes `Final:` du ledger (fixed / Ruling / minor (deferred)), copier dans
  `.superpowers/php-forge-decisions.md`, supprimer `.superpowers/sdd/2026-10-05-php-forge-0.6-formatting/`.
- Mineurs de la revue 0.6 à différer (ledger) : `do {} \n while` non rejoint ; `foo($a, )` sur une ligne ;
  `$a = & $b` ; réalignement « * » de tous les `/*` (pas seulement `/**`) ; fin de ligne CRLF imposée aux fichiers
  mixtes ; sélection qui réindente la ligne suivante ; accolade de fonction déplacée sur une ligne de template
  (`<?php function f() { ?>`) ; double niveau dans une condition multiligne ; formatage à la frappe sur un
  fichier non formaté ; pas de fixture avec accents.

## Demande de l'utilisateur à traiter

Capture : `$prompt = "…de la " . $rp_facilityTypeName . ": ". $x['nom']."… de tipo ". $y .' y se encuentra en '.
$z .'(' . $w .') <br>';` — **les guillemets mélangés ne sont pas signalés**. Raison : la règle
`sql-mixed-quotes` (`src/server/sql/quotes.ts`) ne regarde que les requêtes SQL, et cette chaîne n'en est pas une.
À faire : une règle `mixed-quotes` pour toute concaténation de chaînes qui mélange `'` et `"` (même logique et
même correction rapide que `sql-mixed-quotes` : guillemets qui demandent le moins d'échappements, doubles à
égalité ; morceaux qui ne font qu'entourer une valeur tolérés), code distinct, réglable par
`phpForge.diagnostics.rules`. Mesurer le bruit sur CRM-FR avant de choisir le niveau (avertissement comme la
règle SQL si le nombre reste raisonnable, sinon information). Les racines de concaténation sont déjà relevées par
`scan()` dans `src/server/sql/tokens.ts` (celles qui ne sont pas du SQL y sont aujourd'hui écartées).

## 0.7 SQL — brouillon et décisions

Branche `wip/php-forge-0.7-sql-draft` (566 tests verts au moment du brouillon) :
- `sql/tokens.ts` : `findQueries(tree)` → `SqlQuery { root, parts, complete }` (requête entière : un seul
  littéral, variable jamais complétée par `.=` ni concaténée), mémorisé par arbre ;
- `sql/text.ts` : texte SQL avec trous `?n?` pour les parties calculées, position de chaque caractère dans le
  document (`sqlText`, `sqlOffset`) ;
- `sql/analyze.ts` : lexer et analyse tolérante (tables et alias, colonnes, liste du SELECT, contexte au curseur) ;
- `sql/schema.ts` : `CREATE TABLE` / `ALTER TABLE … ADD` des fichiers .sql, cache JSON de la base ; table
  `complete` seulement avec `CREATE TABLE` ou la base ;
- `sql/diagnostics.ts` : `sql-syntax` (virgule avant FROM/WHERE, WHERE AND/OR ; parenthèse et guillemet non fermés
  dans une requête entière), `sql-unknown-column` (tables complètes), `sql-unknown-table` (schéma de la base
  seulement) ;
- `sql/features.ts` : complétion (tables, colonnes selon les alias, fonctions), survol, cible de définition ;
- `sql/rows.ts` + `types/flow.ts` / `types/infer.ts` / `completion/complete.ts` : `$row = mysqli_fetch_assoc($res)`,
  `$res->fetch_assoc()`, `$stmt->fetch(PDO::FETCH_ASSOC)`, `fetchAll()` typés par les colonnes du SELECT ;
  `extract($row)` définit une variable par colonne.

Décisions mesurées sur le corpus (à reporter en rulings dans le plan 0.7) :
- **Pas de `node-sql-parser`** (Apache-2.0, essai sur CRM-FR) : il refuse du MySQL valide (`INSERT … VALUE (…)`)
  et ne sait pas lire les parties calculées (`LIMIT $n`, conditions ajoutées par variable) → environ 7 % de fausses
  erreurs sur les requêtes entières. Analyse maison tolérante à la place ; `sql-syntax` réduit à des vérifications
  sûres (3 alertes sur CRM-FR).
- Un fichier de migration qui ne fait qu'`ALTER TABLE` donne une table partielle : jamais utilisée pour signaler
  une colonne inconnue. Une liste de tables lue dans des .sql peut être partielle : table inconnue signalée
  seulement avec le schéma de la base.
- CRM-BE (467 tables dans ses .sql) : 31 252 colonnes vérifiées, 994 inconnues (3 %, sans doute des dumps
  anciens) — documenter « le schéma .sql doit être à jour ; la commande Refresh SQL schema fait foi ».

Reste à faire pour 0.7 (spec §5.6), à écrire en plan à partir du brouillon puis exécuter : branchement serveur
(complétion / survol / définition dans les chaînes SQL, diagnostics dans `semanticPart`, chargement du schéma
selon `phpForge.sql.schema` — défaut `sql/**/*.sql`, `migrations/**/*.sql` — et rechargement par l'observateur de
fichiers, `.sql` et `.vscode/php-forge-schema.json` à observer côté client) ; commande « Refresh SQL schema »
côté client (connexion MySQL / MariaDB en lecture seule sur `INFORMATION_SCHEMA`, réglage
`phpForge.sql.connection`, mot de passe dans `SecretStorage`, cache `.vscode/php-forge-schema.json`) ; grammaire
d'injection TextMate (`syntaxes/`) ; fixture `test/fixtures/sql-schema/`, e2e, bench, documentation 0.7.0.

Attention en rebasant le brouillon sur 0.6 finie : `uses.ts` a reçu une mémorisation par arbre dans 0.6 (complétion
p95 revenue à 98 ms) ; le brouillon 0.7 la contient déjà (branche partie de `a08983a`).

## Ensuite

0.8 sécurité (propagation, §5.7) et migration de version (§5.8), 0.9 intégration FTP SFTP Deploy (§5.9), 1.0
(performances §3 : compaction du cache — réouverture 5,6 s contre 3 s visés —, références d'une fonction très
utilisée 2,9 s contre 2 s visés ; documentation, traduction française complète, empaquetage). À la fin : rapport
en français avec tous les rulings et mineurs différés (`.superpowers/php-forge-decisions.md`), liste des branches
et commandes de push / merge pour l'utilisateur.
