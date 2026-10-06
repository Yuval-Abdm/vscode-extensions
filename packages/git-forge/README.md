# Git Forge

**Free and lightweight Git tools for VS Code: inline blame, file history, conflict resolution, local merge and commit graph — no account, no paid tier, nothing you did not ask for.**

> Preview (0.6). Interface in English and French (follows the VS Code display language).

## Features

- **Current line blame**: author, relative date and commit message at the end of the line you are on, shown after a short pause. Lines you added or changed and did not commit yet show *You • Uncommitted changes* — the blame follows your unsaved edits.
- **Blame hover**: full commit message, author, e-mail and date, with **Compare with previous revision**, **Open file at this commit** and **Copy SHA**.
- **Status bar**: author and date of the current line; click it to see the history of the line.
- **File blame** (*Git Forge: Toggle File Blame*): author and date for each block of lines in a margin on the left, with a colored edge by age — from orange (this week) to grey (more than a year).
- **File History** view (Source Control panel): the commits of the active file, following renames, 50 at a time. Click a commit to compare the file with its previous revision; expand it to see every file it changed. Right-click: open the file at that commit, compare with the working file, copy the SHA or the message. The view follows the active editor — pin it to keep a file.
- **Line History**: select lines and run *Show Line History* (editor context menu), or click the blame in the status bar: only the commits that changed those lines.
- **Conflicts** view (Source Control panel), shown during a merge, rebase, cherry-pick or revert with conflicts: every conflicted file and every conflict block in it. Click a block to jump to it; **Keep Mine**, **Keep Theirs** or **Keep Both** for that block, or for the whole file; open VS Code's 3-way merge editor; **Mark as Resolved** (refused while conflict markers remain). Files deleted on one side can be kept or deleted. **Finish** commits the merge (or continues the rebase / cherry-pick / revert); **Abort** cancels it.
- **Merge Locally** (button in the Source Control title bar): pick the branch to merge into the current one (or change the target). Git Forge fetches, fast-forwards the target **and** the source to their remote branches (never a hidden merge: diverged branches stop everything), then merges. Options, remembered: delete the merged branch locally, also on the remote, always create a merge commit (`--no-ff`). Uncommitted changes can be stashed first. On conflicts, the Conflicts view opens and the branch is deleted when you finish.
- **Compare** view: pick two references — branch, remote branch, tag, commit SHA or the working tree — and see the commits and a tree of the changed files; click a file for its diff. From the common ancestor (`A...B`, what the right side changed) or direct (`A..B`), swap sides in one click. With [FTP SFTP Deploy](https://marketplace.visualstudio.com/items?itemName=yuval-abdm.ftp-sftp-deploy) installed, **Deploy These Files** uploads the current version of every changed file (deleted files are never sent), after a confirmation that names the server.
- **Stashes** view: every stash and its files (untracked ones included), diff on click, apply, pop, delete; **Stash All Changes** includes untracked files.
- **Worktrees** view: every worktree of the repository; create one from an existing or a new branch, open it in a new window, remove it (with an explicit confirmation if it has changes).
- **Commit graph** (*Show Graph*, or the branch button in the Source Control title bar): every branch, remote branch and tag, or the current branch only; search by message, author, SHA or branch (Enter jumps to the next match); select a commit to see its full message and files, double-click a file for its diff. Right-click a commit: checkout (detached), create a branch or a tag here, compare with HEAD or with the selected commit, copy the SHA. Right-click a branch: checkout, Merge Locally into the current branch, delete (with a clear warning when it is not merged). Loads 500 commits at a time and only draws what is visible, so large repositories stay smooth.
- **Guided operations** (right-click a commit in the graph or the File History view), each one explained before it runs:
  - **Cherry-pick** and **Revert**: the confirmation names the commit and the branch; a merge commit is applied relative to its first parent; conflicts open the Conflicts view.
  - **Reset**: soft, mixed or hard, each explained in one line. Hard lists the uncommitted changes that will be lost and asks twice. A backup tag `git-forge/backup/…` is created on the current commit before any reset that could lose work.
  - **Interactive rebase**: an editor lists the commits after the chosen one (oldest first): drag to reorder, pick / reword / edit / squash / fixup / drop, edit the messages in place. Uncommitted changes are stashed and restored; a stop (conflict, edit) is finished from the Conflicts view.
  - With `gitForge.rebaseEditor` on and VS Code as your Git editor, `git rebase -i` started in a terminal opens the same editor.
  - Good to know: backup tags are ordinary local tags (`git push --tags` would publish them; delete them with `git tag -d` when you no longer need them). An interactive rebase also creates one. Stacked branches are not moved by the rebase editor (`rebase.updateRefs` is not applied).

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
| `gitForge.compare.enabled` | `true` | Compare, Stashes and Worktrees views |
| `gitForge.graph.enabled` | `true` | Commit graph |
| `gitForge.operations.enabled` | `true` | Cherry-pick, revert, reset and interactive rebase in the commit menus |
| `gitForge.rebaseEditor` | `false` | Open `git rebase -i` todo lists in Git Forge's editor |

Every feature can be turned off: nothing is registered for a disabled feature.

## Requirements

Git, and VS Code's built-in Git extension (enabled by default). Git Forge uses the Git it finds.
