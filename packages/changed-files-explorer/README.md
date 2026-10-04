# Changed Files Explorer

All your git changed files in one **Explorer-like view**, updated automatically — with the full right-click menu you're used to.

## Features

- **Changed Files** view in the Explorer, with a badge showing how many files changed.
- Categories: **Merge Changes** (conflicts), **Staged Changes**, **Changes**, **Untracked**.
- **Since branch**: also list every file changed since the merge base with a branch (e.g. `main`) — commits of your branch plus uncommitted work. Pick it with the branch button in the view title.
- **Flat list** mode (list/tree button): each file once, with its status letters.
- **Click opens the file**, like the Explorer. The diff icon (or right-click → *Open Changes*) shows the changes.
- **Explorer-like right-click menu**: Open to the Side, Reveal in File Explorer, Reveal in Explorer View, Open in Integrated Terminal, Find in Folder, Copy Path / Copy Relative Path, Rename (F2), Delete (Del), plus Stage / Unstage / Discard Changes.
- **Multi-selection** (Ctrl/Shift + click), copy the list of all changed paths, multi-root and multi-repository workspaces.

## One-click deploy (optional)

Install the companion extension **FTP SFTP Deploy** and configure a server: a cloud button appears in the view title to **deploy all changed files** at once (to their relative location), with a summary first. Changed and new files are uploaded; deleted or renamed files can be removed from the server. Per category and per selection too, plus *Compare with server* and *Delete from server*.

These buttons only appear when FTP SFTP Deploy is installed and configured — Changed Files Explorer works fully on its own.

## Settings

| Setting | Default | Description |
|---|---|---|
| `changedFiles.groupByStatus` | `true` | Group files by category, or show a flat de-duplicated list |
| `changedFiles.baseBranch` | `""` | Base branch to compare with (empty = disabled) |

## Languages

English, and French automatically when VS Code is in French.

## Français

Tous vos fichiers modifiés git dans une vue façon Explorateur, avec le clic droit complet (ouvrir sur le côté, révéler, terminal, copier le chemin, renommer, supprimer, indexer/désindexer/ignorer). Catégories, comparaison depuis une branche, liste plate, multi-sélection. Déploiement en un clic de tous les fichiers modifiés avec l'extension compagnon **FTP SFTP Deploy**. L'interface s'affiche en français quand VS Code est en français.
