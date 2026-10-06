# VS Code extensions

Three independent VS Code extensions, developed together.

| Extension | Marketplace | Open VSX | What it does |
|---|---|---|---|
| [**Changed Files Explorer**](packages/changed-files-explorer) | [yuval-abdm.changed-files-explorer](https://marketplace.visualstudio.com/items?itemName=yuval-abdm.changed-files-explorer) | [open-vsx.org](https://open-vsx.org/extension/yuval-abdm/changed-files-explorer) | All your git changed files in an Explorer-like view, with the full right-click menu |
| [**FTP SFTP Deploy**](packages/ftp-sftp-deploy) | [yuval-abdm.ftp-sftp-deploy](https://marketplace.visualstudio.com/items?itemName=yuval-abdm.ftp-sftp-deploy) | [open-vsx.org](https://open-vsx.org/extension/yuval-abdm/ftp-sftp-deploy) | Deploy over FTP, FTPS and SFTP; browse and edit the server; migrate from `sftp.json` |
| [**PHP Forge**](packages/php-forge) | [yuval-abdm.php-forge](https://marketplace.visualstudio.com/items?itemName=yuval-abdm.php-forge) | [open-vsx.org](https://open-vsx.org/extension/yuval-abdm/php-forge) | Free PHP language server: navigation, diagnostics, include-aware analysis (preview) |

Each extension works on its own. When both are installed, Changed Files Explorer uses FTP SFTP Deploy's public API to deploy every changed file in one click.

Both are in English, with French shipped as a translation (`package.nls.fr.json`, `l10n/bundle.l10n.fr.json`).

## Development

Requires Node.js 18+.

PHP Forge is written in TypeScript and its tests run the sources directly: they need Node.js 22.18+. Its build clones JetBrains/phpstorm-stubs once into `packages/php-forge/.cache/`.

```bash
npm run typecheck                     # PHP Forge: tsc --noEmit
npm run test:e2e:php-forge            # PHP Forge in a real VS Code
npm run bench --workspace php-forge   # local benchmark on real projects (PHP_FORGE_CORPUS=/a:/b)
```

```bash
npm install            # npm workspaces
npm run build          # esbuild bundles → packages/*/dist
npm test               # unit tests, FTP/SFTP client tests against local servers, translation consistency
npm run test:e2e       # both extensions in a real VS Code, against local FTP/SFTP servers
npm run package        # one .vsix per extension, in packages/*/
npm run icons          # regenerate media/icon.png from media/icon.svg
```

Press F5 to run both extensions in an Extension Development Host.

Running the e2e tests on WSL without `libasound.so.2`: `apt download libasound2t64 && dpkg -x libasound2t64*.deb .vscode-test/libs/root`, then prefix the command with `LD_LIBRARY_PATH=$PWD/.vscode-test/libs/root/usr/lib/x86_64-linux-gnu`.

## Repository layout

```
packages/
  changed-files-explorer/   extension: src/, l10n/, media/, package.json
  ftp-sftp-deploy/          extension: src/, l10n/, media/, schema/, test/
  php-forge/                extension: src/{client,server,shared}, l10n/, media/, scripts/, test/
test/
  e2e/run.js                launches VS Code with both extensions and local servers
  l10n.test.js              checks every UI string has its French translation
scripts/icons.js            SVG → PNG icons
```

## License

[MIT](LICENSE)
