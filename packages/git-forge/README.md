# Git Forge

**Free and lightweight Git tools for VS Code: inline blame, file history, conflict resolution, local merge and commit graph — no account, no paid tier, nothing you did not ask for.**

> Preview (0.3). Interface in English and French (follows the VS Code display language).

## Features

- **Current line blame**: author, relative date and commit message at the end of the line you are on, shown after a short pause. Lines you added or changed and did not commit yet show *You • Uncommitted changes* — the blame follows your unsaved edits.
- **Blame hover**: full commit message, author, e-mail and date, with **Compare with previous revision**, **Open file at this commit** and **Copy SHA**.
- **Status bar**: author and date of the current line; click it to see the history of the line.
- **File blame** (*Git Forge: Toggle File Blame*): author and date for each block of lines in a margin on the left, with a colored edge by age — from orange (this week) to grey (more than a year).
- **File History** view (Source Control panel): the commits of the active file, following renames, 50 at a time. Click a commit to compare the file with its previous revision; expand it to see every file it changed. Right-click: open the file at that commit, compare with the working file, copy the SHA or the message. The view follows the active editor — pin it to keep a file.
- **Line History**: select lines and run *Show Line History* (editor context menu), or click the blame in the status bar: only the commits that changed those lines.
- **Conflicts** view (Source Control panel), shown during a merge, rebase, cherry-pick or revert with conflicts: every conflicted file and every conflict block in it. Click a block to jump to it; **Keep Mine**, **Keep Theirs** or **Keep Both** for that block, or for the whole file; open VS Code's 3-way merge editor; **Mark as Resolved** (refused while conflict markers remain). Files deleted on one side can be kept or deleted. **Finish** commits the merge (or continues the rebase / cherry-pick / revert); **Abort** cancels it.
- **Merge Locally** (button in the Source Control title bar): pick the branch to merge into the current one (or change the target). Git Forge fetches, fast-forwards the target **and** the source to their remote branches (never a hidden merge: diverged branches stop everything), then merges. Options, remembered: delete the merged branch locally, also on the remote, always create a merge commit (`--no-ff`). Uncommitted changes can be stashed first. On conflicts, the Conflicts view opens and the branch is deleted when you finish.

## Settings

| Setting | Default | What |
|---|---|---|
| `gitForge.blame.enabled` | `true` | Current line blame and file blame |
| `gitForge.blame.format` | `${author}, ${date} • ${message}` | Text at the end of the line (`${author}`, `${date}`, `${message}`, `${sha}`) |
| `gitForge.blame.statusBar` | `true` | Author and date in the status bar |
| `gitForge.blame.maxLines` | `20000` | Files longer than this have no blame |
| `gitForge.history.enabled` | `true` | File History view |
| `gitForge.conflicts.enabled` | `true` | Conflicts view |
| `gitForge.merge.enabled` | `true` | Merge Locally command |

Every feature can be turned off: nothing is registered for a disabled feature.

## Requirements

Git, and VS Code's built-in Git extension (enabled by default). Git Forge uses the Git it finds.

## Roadmap

Branch comparison with stash and worktrees, commit graph, guided cherry-pick / revert / reset / interactive rebase.
