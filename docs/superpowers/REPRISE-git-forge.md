# Git Forge — note de reprise (2026-10-06, après 1.0)

Note pour reprendre le travail dans une nouvelle session. Demande de l'utilisateur : **« enchaîne tout jusqu'à la
1.0 »** — jalons 0.1 → 1.0 enchaînés sans merge, sans push, sans publication.

## Contraintes permanentes

- Répondre en français ; finir chaque tâche par le rapport « 📁 Fichiers modifiés / ✅ Fichiers créés /
  🗑️ Fichiers supprimés ».
- Commits **sans** `Co-Authored-By` ni mention de Claude ; jamais de `git push`.
- Spec : `docs/superpowers/specs/2026-10-06-git-forge-design.md` ; plans : `docs/superpowers/plans/2026-10-06-git-forge-*.md`.
- Rulings et mineurs différés de chaque revue : `.superpowers/git-forge-decisions.md` (non versionné).
- Méthode : un plan par jalon (writing-plans), exécution inline, revue de la branche par un agent sur le modèle le plus
  capable, corrections RED → GREEN, puis jalon suivant.

## Commandes utiles

    cd packages/git-forge && npm test        # tests unitaires, contre de vrais dépôts git
    npx tsc -p .                              # types
    npm run bench                             # objectifs de performance (dépôt de 10 000 commits)
    node ../../test/l10n.test.js              # traductions
    cd ../.. && LD_LIBRARY_PATH=$PWD/.vscode-test/libs/root/usr/lib/x86_64-linux-gnu npm run test:e2e:git-forge

## État des branches

Chaque branche part de la précédente : `feat/git-forge-0.1` → `0.2` → `0.3` → `0.4` → `0.5` → `0.6` → `1.0`.
Chaque jalon a été revu et corrigé. Rien n'est mergé ni poussé ; fusionner `feat/git-forge-1.0` suffit.

## Reste à faire par l'utilisateur

    git push -u origin feat/git-forge-1.0
    git switch main && git merge --no-ff feat/git-forge-1.0
    cd packages/git-forge && npx vsce publish --packagePath git-forge-1.0.0.vsix
    npx ovsx publish git-forge-1.0.0.vsix
