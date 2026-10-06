// Lance un vrai VS Code avec PHP Forge sur une copie du projet de test.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'php-forge-e2e-'));
  const workspace = path.join(tmp, 'workspace');
  fs.cpSync(path.join(__dirname, '..', 'fixtures', 'basic-project'), workspace, { recursive: true });
  let code = 0;
  try {
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, '../..'),
      extensionTestsPath: path.resolve(__dirname, 'suite.cjs'),
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--user-data-dir', path.join(tmp, 'user-data')],
      extensionTestsEnv: { PHP_FORGE_WORKSPACE: workspace },
    });
  } catch (err) {
    console.error('Échec des tests e2e :', err);
    code = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(code);
}

main();
