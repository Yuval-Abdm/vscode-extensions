# Changelog

## 1.0.0

- First stable release: inline blame, file and line history, conflicts view and local merge, compare / stashes / worktrees with deploy, commit graph, guided cherry-pick / revert / reset / interactive rebase.
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
