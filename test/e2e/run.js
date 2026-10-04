// Lance un vrai VS Code avec l'extension, un espace de travail git et des serveurs FTP/SFTP locaux.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { runTests } = require('@vscode/test-electron');
const { startFtp, startSftp, USER, PASSWORD } = require('../../packages/ftp-sftp-deploy/test/servers');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-ext-e2e-'));
  const ftpRoot = path.join(tmp, 'ftp');
  const sftpRoot = path.join(tmp, 'sftp');
  const workspace = path.join(tmp, 'workspace');
  for (const d of [ftpRoot, sftpRoot, workspace]) fs.mkdirSync(d, { recursive: true });

  const ftp = await startFtp(ftpRoot);
  const sftp = await startSftp(sftpRoot);

  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true });
    fs.writeFileSync(path.join(workspace, rel), content);
  };
  write('index.php', '<?php echo "v1";');
  write('includes/js/app.js', 'console.log(1);');
  write('old.php', 'old');
  write('node_modules/lib/x.js', 'ignored');
  write('debug.log', 'ignored');
  write('.vscode/deploy.json', JSON.stringify({
    defaultProfile: 'ftp',
    ignore: ['.git', '.vscode', 'node_modules', '*.log'],
    profiles: {
      ftp: { protocol: 'ftp', host: '127.0.0.1', port: ftp.port, username: USER, remotePath: '/www' },
      // commentaire et virgule finale tolérés : vérifié par le test de parsing
      sftp: { protocol: 'sftp', host: '127.0.0.1', port: sftp.port, username: USER, remotePath: '/srv/site', uploadOnSave: true },
    },
  }, null, 2).replace('"profiles": {', '"profiles": { // serveurs\n').replace(/\n  }\n}$/, ',\n  }\n}'));
  // Dossier de projets pour la migration en lot (hors espace de travail)
  const projects = path.join(tmp, 'projects');
  const sftpJson = (dir, cfg) => {
    fs.mkdirSync(path.join(projects, dir, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(projects, dir, '.vscode/sftp.json'), JSON.stringify(cfg));
  };
  sftpJson('client-a', { name: 'Client A', host: 'ftp.a.test', protocol: 'ftp', port: 21, username: 'ua', password: 'pa', remotePath: '/public_html/' });
  sftpJson('group/client-b', { name: 'client-b', host: 'sftp.b.test', protocol: 'sftp', port: 22, username: 'ub', password: 'pb', remotePath: '/var/www' });
  sftpJson('client-a/node_modules/pkg', { name: 'ignored', host: 'x' });
  fs.writeFileSync(path.join(projects, 'client-a/index.php'), '');

  const git = (cmd) => execSync(`git ${cmd}`, { cwd: workspace, stdio: 'pipe' });
  git('init -q');
  git('-c user.email=t@t -c user.name=t add -A');
  git('-c user.email=t@t -c user.name=t commit -qm init');

  let code = 0;
  try {
    await runTests({
      // Les deux extensions sont chargées ensemble (Changed Files Explorer utilise l'API de FTP SFTP Deploy)
      extensionDevelopmentPath: [
        path.resolve(__dirname, '../../packages/ftp-sftp-deploy'),
        path.resolve(__dirname, '../../packages/changed-files-explorer'),
      ],
      extensionTestsPath: path.resolve(__dirname, '../../packages/ftp-sftp-deploy/test/e2e/suite.js'),
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--user-data-dir', path.join(tmp, 'user-data')],
      extensionTestsEnv: { GMF_FTP_ROOT: ftpRoot, GMF_SFTP_ROOT: sftpRoot, GMF_PASSWORD: PASSWORD, GMF_WORKSPACE: workspace, GMF_PROJECTS: projects },
    });
  } catch (err) {
    console.error('Échec des tests e2e :', err);
    code = 1;
  } finally {
    await ftp.close();
    await sftp.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(code);
}

main();
