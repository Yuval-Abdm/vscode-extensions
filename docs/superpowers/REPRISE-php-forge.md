# PHP Forge — note de reprise (2026-10-05, mise à jour après 0.9)

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
| `feat/php-forge-0.6` | 0.6 Formatage — terminée, revue faite et corrigée (`d46db76`) |
| `feat/php-forge-0.7` | 0.7 SQL — terminée, revue faite et corrigée (plan `docs/superpowers/plans/2026-10-05-php-forge-0.7-sql.md`) ; contient la règle `mixed-quotes` demandée |
| `feat/php-forge-0.8` | 0.8 Sécurité et migration — terminée, revue faite et corrigée (plan `docs/superpowers/plans/2026-10-05-php-forge-0.8-security-migration.md`) |
| `feat/php-forge-0.9` | 0.9 Intégration FTP SFTP Deploy — terminée, revue faite et corrigée (plan `docs/superpowers/plans/2026-10-05-php-forge-0.9-deploy.md`) |
| `wip/php-forge-0.7-sql-draft` | Brouillon repris dans `feat/php-forge-0.7` : peut être supprimée |

Chaque branche part de la précédente. Rien n'est mergé ni poussé. Rulings et mineurs différés de chaque jalon :
`.superpowers/php-forge-decisions.md`.

## Ensuite

1.0 sur une branche `feat/php-forge-1.0` partie de `feat/php-forge-0.9` : performances (§3) — réouverture avec cache
6,1 s mesurés contre 3 s visés : `indexFolder` réécrit tout le cache (JSON 260 Mo + gzip, ≈ 3 s) même sans changement,
à éviter ; références d'une fonction très utilisée 3,0 s contre 2 s ; tas du bench 2 Go (serveur visé < 1,5 Go) —,
documentation, traduction française complète, empaquetage (publication par l'utilisateur). À la fin : rapport en
français avec tous les rulings et mineurs différés (`.superpowers/php-forge-decisions.md`), branches, commandes de
push / merge / publication.
