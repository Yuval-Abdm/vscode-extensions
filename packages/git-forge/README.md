# Git Forge

**Free and lightweight Git tools for VS Code: inline blame, file history, conflict resolution, local merge and commit graph — no account, no paid tier, nothing you did not ask for.**

> Preview (0.1). Interface in English and French (follows the VS Code display language).

## Features

- **Current line blame**: author, relative date and commit message at the end of the line you are on, shown after a short pause. Lines you added or changed and did not commit yet show *You • Uncommitted changes* — the blame follows your unsaved edits.
- **Blame hover**: full commit message, author, e-mail and date, with **Compare with previous revision**, **Open file at this commit** and **Copy SHA**.
- **Status bar**: author and date of the current line; click it to see the commit.
- **File blame** (*Git Forge: Toggle File Blame*): author and date for each block of lines in a margin on the left, with a colored edge by age — from orange (this week) to grey (more than a year).

## Settings

| Setting | Default | What |
|---|---|---|
| `gitForge.blame.enabled` | `true` | Current line blame and file blame |
| `gitForge.blame.format` | `${author}, ${date} • ${message}` | Text at the end of the line (`${author}`, `${date}`, `${message}`, `${sha}`) |
| `gitForge.blame.statusBar` | `true` | Author and date in the status bar |
| `gitForge.blame.maxLines` | `20000` | Files longer than this have no blame |

Every feature can be turned off: nothing is registered for a disabled feature.

## Requirements

Git, and VS Code's built-in Git extension (enabled by default). Git Forge uses the Git it finds.

## Roadmap

File and line history, conflict view and local merge, branch comparison with stash and worktrees, commit graph, guided cherry-pick / revert / reset / interactive rebase.
