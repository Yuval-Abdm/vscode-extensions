# Changelog

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
