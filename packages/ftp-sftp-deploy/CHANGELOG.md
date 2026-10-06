# Changelog

## Unreleased
- Search files on the server from the Remote Server view: a « Search a file… » row at the top of each server. Type part of the name or path, letters in order (`usrctl` finds `src/user/UserController.php`); the matching files replace the folders in the tree while you type, matched letters in bold, with their usual actions (open, compare, download…). « Clear the search » brings the folders back. The file list is read on first use and kept until something changes on the server (Refresh reads it again).

## 1.0.1
- Repository, issues and homepage links on the Marketplace page.

## 1.0.0
- First release: FTP, FTPS and SFTP deploy (upload, download, compare, delete from server), Remote Server view with in-place editing, upload on save, multiple profiles, passwords in VS Code secret storage, migration from sftp.json (single project or bulk) with optional deletion of old files. English and French.
