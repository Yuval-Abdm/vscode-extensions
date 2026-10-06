// Lance un vrai VS Code avec Git Spark sur un dépôt Git créé pour l'occasion.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

function makeWorkspace(dir) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (args, extra = {}) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...env, ...extra } });
  const commit = (message, author, date) => {
    git(['add', '-A']);
    git(['commit', '-q', '-m', message], { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${author.toLowerCase()}@example.com`, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    return git(['rev-parse', 'HEAD']).trim();
  };
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Test User']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  const first = commit('first commit', 'Alice', '2026-01-01T10:00:00Z');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');
  const second = commit('second commit', 'Bob', '2026-02-01T10:00:00Z');
  return { first, second };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-spark-e2e-'));
  const workspace = path.join(tmp, 'workspace');
  const shas = makeWorkspace(workspace);
  let code = 0;
  try {
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, '../..'),
      extensionTestsPath: path.resolve(__dirname, 'suite.cjs'),
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--locale', 'en', '--user-data-dir', path.join(tmp, 'user-data')],
      extensionTestsEnv: { GIT_SPARK_WORKSPACE: workspace, GIT_SPARK_SHAS: JSON.stringify(shas) },
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
