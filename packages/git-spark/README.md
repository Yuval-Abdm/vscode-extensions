# Git Spark

**Free and lightweight Git tools for VS Code: inline blame, file history, conflict resolution, local merge and commit graph — no account, no paid tier, nothing you did not ask for.**

> 1.0. Interface in English and French (follows the VS Code display language).

## Features

The **Git Spark** icon of the activity bar holds Commit (open), then Conflicts (only while a merge, rebase, cherry-pick or revert is in progress), File History, Compare, Stashes and Worktrees (collapsed). The commit graph has its own **Git Spark** tab in the bottom panel, next to the Terminal. VS Code's Source Control panel is left untouched. The blame stays in the editor and the status bar.


- **Current line blame**: author, relative date and commit message at the end of the line you are on, shown after a short pause. Lines you added or changed and did not commit yet show *You • Uncommitted changes* — the blame follows your unsaved edits.
- **Blame hover**: full commit message, author, e-mail and date, with **Compare with previous revision**, **Open file at this commit** and **Copy SHA**.
- **Status bar**: author and date of the current line; click it to see the history of the line.
- **File blame** (*Git Spark: Toggle File Blame*): author and date for each block of lines in a margin on the left, with a colored edge by age — from orange (this week) to grey (more than a year).
- **File History** view: the commits of the active file, following renames, 50 at a time. Click a commit to compare the file with its previous revision; expand it to see every file it changed. Right-click: open the file at that commit, compare with the working file, copy the SHA or the message. The view follows the active editor — pin it to keep a file.
- **Line History**: select lines and run *Show Line History* (editor context menu), or click the blame in the status bar: only the commits that changed those lines.
- **Conflicts** view, shown during a merge, rebase, cherry-pick or revert with conflicts: every conflicted file and every conflict block in it. Click a block to jump to it; **Keep Mine**, **Keep Theirs** or **Keep Both** for that block, or for the whole file; open VS Code's 3-way merge editor; **Mark as Resolved** (refused while conflict markers remain). Files deleted on one side can be kept or deleted. **Finish** commits the merge (or continues the rebase / cherry-pick / revert); **Abort** cancels it.
- **Merge Locally** (button in the title bar of the Graph view, or the command palette): pick the branch to merge into the current one (or change the target). Git Spark fetches, fast-forwards the target **and** the source to their remote branches (never a hidden merge: diverged branches stop everything), then merges. Options, remembered: delete the merged branch locally, also on the remote, always create a merge commit (`--no-ff`). Uncommitted changes can be stashed first. On conflicts, the Conflicts view opens and the branch is deleted when you finish.
- **Compare** view: pick two references — branch, remote branch, tag, commit SHA or the working tree — and see the commits and a tree of the changed files; click a file for its diff. From the common ancestor (`A...B`, what the right side changed) or direct (`A..B`), swap sides in one click. With [FTP SFTP Deploy](https://marketplace.visualstudio.com/items?itemName=yuval-abdm.ftp-sftp-deploy) installed, **Deploy These Files** uploads the current version of every changed file (deleted files are never sent), after a confirmation that names the server.
- **Stashes** view: every stash and its files (untracked ones included), diff on click, apply, pop, delete; **Stash All Changes** includes untracked files.
- **Worktrees** view: every worktree of the repository; create one from an existing or a new branch, open it in a new window, remove it (with an explicit confirmation if it has changes).
- **Commit** view, at the top of the Git Spark sidebar: the files of the active editor's repository, staged and unstaged (**+** / **−** on hover, for a file or a whole group; click a file for its diff). Pick a conventional commit type from the list (✨ feat, 🐛 fix, ♻️ refactor, ⚡ perf, 📝 docs…, each with its description), an optional scope and **!** for a breaking change: the prefix is written at the start of the message, and typing it by hand works too. **Commit** or **Commit & Push** (Ctrl+Enter commits); a counter shows the summary length. **Pull before commit** (on by default) pulls with `--rebase` first: your changes are set aside and restored exactly, staged files included. Conflicted files cannot be staged from here, and the commit is refused while a rebase, cherry-pick or revert is in progress.
- **Commit graph**, in the **Git Spark** tab of the bottom panel (the graph of the active editor's repository, with message, author, date and SHA columns; the selected commit's details on the right; compact with author and date on hover if you drag it into a sidebar), or in an editor tab (*Show Graph*, or ⤢ in the view): every branch, remote branch and tag, or the current branch only; search by message, author, SHA or branch (Enter jumps to the next match); select a commit to see its full message and files, double-click a file for its diff. Right-click a commit: checkout (detached), create a branch or a tag here, compare with HEAD or with the selected commit, copy the SHA. Right-click a branch: checkout, Merge Locally into the current branch, delete (with a clear warning when it is not merged). Loads 500 commits at a time and only draws what is visible, so large repositories stay smooth.
- **Guided operations** (right-click a commit in the graph or the File History view), each one explained before it runs:
  - **Cherry-pick** and **Revert**: the confirmation names the commit and the branch; a merge commit is applied relative to its first parent; conflicts open the Conflicts view.
  - **Reset**: soft, mixed or hard, each explained in one line. Hard lists the uncommitted changes that will be lost and asks twice. A backup tag `git-spark/backup/…` is created on the current commit before any reset that could lose work.
  - **Interactive rebase**: an editor lists the commits after the chosen one (oldest first): drag to reorder, pick / reword / edit / squash / fixup / drop, edit the messages in place. Uncommitted changes are stashed and restored; a stop (conflict, edit) is finished from the Conflicts view.
  - With `gitSpark.rebaseEditor` on and VS Code as your Git editor, `git rebase -i` started in a terminal opens the same editor.
  - Good to know: backup tags are ordinary local tags (`git push --tags` would publish them; delete them with `git tag -d` when you no longer need them). An interactive rebase also creates one. Stacked branches are not moved by the rebase editor (`rebase.updateRefs` is not applied).

## Performance

Measured on a synthetic repository of 10,000 commits (`npm run bench` in `packages/git-spark`): the blame of the current line is served from cache in well under 100 ms, and the first page of the graph (500 commits, laid out) loads in under 500 ms. Every Git call runs in the background with at most 4 reads at a time per repository, and features you turn off cost nothing.

## Settings

| Setting | Default | What |
|---|---|---|
| `gitSpark.blame.enabled` | `true` | Current line blame and file blame |
| `gitSpark.blame.format` | `${author}, ${date} • ${message}` | Text at the end of the line (`${author}`, `${date}`, `${message}`, `${sha}`) |
| `gitSpark.blame.statusBar` | `true` | Author and date in the status bar |
| `gitSpark.blame.maxLines` | `20000` | Files longer than this have no blame |
| `gitSpark.history.enabled` | `true` | File History view |
| `gitSpark.conflicts.enabled` | `true` | Conflicts view |
| `gitSpark.merge.enabled` | `true` | Merge Locally command |
| `gitSpark.compare.enabled` | `true` | Compare, Stashes and Worktrees views |
| `gitSpark.commit.enabled` | `true` | Commit view |
| `gitSpark.commit.pullBeforeCommit` | `true` | Pull (`--rebase`) before committing from the Commit view |
| `gitSpark.graph.enabled` | `true` | Commit graph |
| `gitSpark.operations.enabled` | `true` | Cherry-pick, revert, reset and interactive rebase in the commit menus |
| `gitSpark.rebaseEditor` | `false` | Open `git rebase -i` todo lists in Git Spark's editor |

Every feature can be turned off: nothing is registered for a disabled feature.

## Requirements

Git, and VS Code's built-in Git extension (enabled by default). Git Spark uses the Git it finds.
