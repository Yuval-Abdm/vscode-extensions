# FTP SFTP Deploy

Deploy your project over **FTP, FTPS and SFTP** right from VS Code: upload files and folders to their place on the server, browse and edit the server, compare with the server, upload on save. Passwords never sit in a file: they are kept in **VS Code secret storage**.

## Features

- **Upload / Download / Compare with server / Delete from server** from the Explorer, the editor and editor tabs (files and folders, multi-selection). Every file keeps its relative path on the server.
- **Remote Server view** (activity bar → *Deploy*): browse each profile's server, open a remote file and **save it straight to the server**, create files and folders, rename, download, compare with the local file, delete (**always with a confirmation**).
- **Upload on save** (`uploadOnSave`).
- **Several profiles** per project (prod, staging…): the active one is shown in the status bar, click it to switch.
- **Migration from the SFTP extension** (Natizyskunk / liximomo): one project or **all your projects at once**, passwords included, with an offer to delete the old `sftp.json` files (they usually contain passwords in plain text).
- Progress notifications with cancellation, detailed logs (*Show deployment logs*).
- Works great with **Changed Files Explorer**: one click deploys every git changed file, and removes deleted files from the server.

## Configuration

Run **FTP SFTP Deploy: Create deployment configuration**. It creates `.vscode/deploy.json` (with auto-completion and validation):

```jsonc
{
  "defaultProfile": "prod",
  "uploadOnSave": false,
  "ignore": [".git", ".vscode", ".DS_Store", "node_modules", "*.log"],
  "profiles": {
    "prod":    { "protocol": "ftp",  "host": "ftp.example.com", "username": "user", "remotePath": "/public_html" },
    "staging": { "protocol": "sftp", "host": "203.0.113.10", "username": "deploy", "remotePath": "/var/www/site",
                 "privateKeyPath": "~/.ssh/id_ed25519", "uploadOnSave": true }
  }
}
```

| Key | Description |
|---|---|
| `protocol` | `ftp`, `ftps` or `sftp` |
| `host`, `port`, `username` | Connection. The password is asked once, then stored in secret storage (shared by every project using the same account). |
| `remotePath` | Remote folder matching the project root |
| `secure`, `rejectUnauthorized` | FTPS: `"implicit"` for implicit TLS; `false` to accept a self-signed certificate |
| `privateKeyPath`, `agent` | SFTP: private key or SSH agent instead of a password |
| `ignore` | Excluded patterns. Without `/`: any path segment (`node_modules`, `*.log`); otherwise the relative path (`config/secret.php`, `dist/**`) |
| `uploadOnSave`, `timeout` | Per profile or for all profiles |

### Coming from the SFTP extension?

- When a folder has a `.vscode/sftp.json` and no `deploy.json`, you are offered to migrate it.
- **Import configuration from sftp.json** migrates the open folder.
- **Migrate all SFTP configurations in a folder…** searches every `.vscode/sftp.json` under a folder (e.g. `~/dev`), lets you pick projects, and migrates them all.

Profiles (`profiles` / `defaultProfile`), FTPS, SSH keys, `ignore`, `uploadOnSave` and `connectTimeout` are converted. `context` is not supported (a warning tells you).

## Commands

Upload to server · Download from server · Compare with server · Delete from server · Switch deployment profile · Create / Open deployment configuration · Import configuration from sftp.json · Migrate all SFTP configurations in a folder · Forget a saved password · Show deployment logs

## Languages

English, French (automatic, following VS Code's display language).

---

## Français

Déploiement **FTP, FTPS et SFTP** depuis VS Code : upload de fichiers et de dossiers à leur emplacement sur le serveur, parcours et édition du serveur, comparaison, upload à l'enregistrement. Les mots de passe restent dans le **coffre sécurisé de VS Code**, jamais dans un fichier. La configuration se trouve dans `.vscode/deploy.json`. La migration depuis l'extension SFTP (un projet ou tous vos projets d'un coup) reprend les mots de passe et propose de supprimer les anciens `sftp.json`. L'interface s'affiche en français si VS Code est en français.
