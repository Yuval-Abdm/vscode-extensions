# Changelog

## Unreleased

- Git asks for your SSH key passphrase (or HTTPS credentials) in a VS Code input box instead of failing.
- Commit & Push: the push is cancelled with an error notification if it has not finished after 30 seconds (time spent typing the passphrase is not counted).
- The Git Spark icon in the activity bar shows the number of changed files (modified, added, deleted or untracked).

## 1.1.0

- Commit view: click the branch to switch to another local branch, check out a remote branch (a local branch tracking it is created) or create a new branch.
- Commit view: discard the changes of a file on hover, or of all files from the Changes header (after confirmation; new untracked files are deleted).

## 1.0.1

- First public release (1.0.0 was withdrawn before release and cannot be reused). Contents below.

## 1.0.0

- First stable release, now named **Git Spark**, with a new icon and logo: inline blame, file and line history, conflicts view and local merge, compare / stashes / worktrees with deploy, commit graph, guided cherry-pick / revert / reset / interactive rebase.
- Its own activity bar container: the Commit view (expanded) — stage and unstage files, conventional commit types with icons and descriptions, optional scope and breaking change, pull (`--rebase`) before committing that keeps staged files exactly, Commit or Commit & Push — then Conflicts, File History, Compare, Stashes and Worktrees (collapsed). VS Code's Source Control panel is left untouched.
- Commit graph in its own tab of the bottom panel, next to the Terminal: colored lanes, branch labels, message / author / date / SHA columns, details on the right (also in an editor tab).
- Performance measured on 10,000 commits (`npm run bench`).

## 0.6.0

- Cherry-pick and revert from the graph and the File History view, merge commits relative to their first parent.
- Reset soft / mixed / hard with explanations, a double confirmation for hard and a backup tag.
- Interactive rebase editor: reorder, pick / reword / edit / squash / fixup / drop, messages edited in place, autostash; optional editor for `git rebase -i` started elsewhere.

## 0.5.0

- Commit graph: all branches or the current one, badges for branches, remote branches, tags and HEAD, search, commit details and files with diff, context menus (checkout, create branch or tag, compare with HEAD, copy SHA, checkout / merge / delete a branch).

## 0.4.0

- Compare view: two references or a reference and the working tree, from the common ancestor or direct; commits and file tree; diff on click; deploy the changed files with FTP SFTP Deploy.
- Stashes view: stashes and their files (untracked included), apply, pop, delete, stash all changes.
- Worktrees view: create from an existing or new branch, open in a new window, remove.

## 0.3.0

- Conflicts view: conflicted files and blocks, keep mine / theirs / both per block or per file, 3-way merge editor, mark as resolved, finish or abort the merge, rebase, cherry-pick or revert.
- Merge Locally: fetch, fast-forward the target and the source to their remote branches, merge, optionally delete the merged branch (locally or also on the remote), offer to push.

## 0.2.0

- File History view: commits of a file (renames followed, 50 at a time), files of each commit, diff on click, open / compare / copy actions, pin.
- Line History: commits that changed the selected lines; the status bar blame opens it.

## 0.1.0

- Current line blame at the end of the line, with hover (full message, compare with previous revision, open file at commit, copy SHA) and status bar.
- File blame: margin with author and date per block of lines, colored by age.
- Blame follows unsaved edits; files not tracked by Git, too long or outside a repository are ignored.
- English and French.
