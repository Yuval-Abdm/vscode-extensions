// Tests exécutés dans le VS Code lancé par run.js (extension host réel).
const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FTP = process.env.GMF_FTP_ROOT;
const SFTP = process.env.GMF_SFTP_ROOT;
const WS = process.env.GMF_WORKSPACE;
const ws = (rel) => vscode.Uri.file(path.join(WS, rel));
const onFtp = (rel) => path.join(FTP, 'www', rel);
const onSftp = (rel) => path.join(SFTP, 'srv/site', rel);
const read = (p) => fs.readFileSync(p, 'utf8');

async function waitFor(check, label, timeout = 15000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await check();
      if (r !== false && r !== undefined) return r;
    } catch (err) {
      if (Date.now() - start > timeout) throw err;
    }
    if (Date.now() - start > timeout) throw new Error(`Délai dépassé : ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let api;
const modals = [];

test('activation et lecture de deploy.json (commentaires, virgules finales)', async () => {
  const ext = vscode.extensions.getExtension('yuval-abdm.ftp-sftp-deploy');
  const publicApi = await ext.activate();
  assert.strictEqual(publicApi.version, 1);
  assert.strictEqual(publicApi.hasConfig(), true);
  api = publicApi._internals;
  const profiles = api.config.profiles();
  assert.deepStrictEqual(profiles.map((p) => p.name), ['ftp', 'sftp']);
  assert.strictEqual(api.config.active(vscode.workspace.workspaceFolders[0]).name, 'ftp');
  // Mots de passe pré-enregistrés dans le coffre (sinon une saisie serait demandée)
  for (const p of profiles) await api.config.context.secrets.store(api.config.secretKey(p), process.env.GMF_PASSWORD);

  // Les dialogues modaux sont validés automatiquement avec le premier bouton
  vscode.window.showWarningMessage = async (message, ...rest) => {
    const opts = typeof rest[0] === 'object' && rest[0] && !Array.isArray(rest[0]) ? rest.shift() : {};
    modals.push(message);
    return opts.modal ? rest[0] : undefined;
  };
  // Même chose pour les dialogues de Changed Files Explorer (autre extension, autre instance d'API)
  require('../../../changed-files-explorer/test/e2e/stubs').autoConfirm(modals);
});

test('upload d’un dossier depuis l’Explorateur : arborescence conservée, exclusions respectées', async () => {
  await vscode.commands.executeCommand('ftpSftpDeploy.upload', ws(''), [ws('')]);
  assert.strictEqual(read(onFtp('index.php')), '<?php echo "v1";');
  assert.strictEqual(read(onFtp('includes/js/app.js')), 'console.log(1);');
  assert.ok(!fs.existsSync(onFtp('node_modules')), 'node_modules exclu');
  assert.ok(!fs.existsSync(onFtp('debug.log')), '*.log exclu');
  assert.ok(!fs.existsSync(onFtp('.vscode')), '.vscode exclu');
  assert.ok(!fs.existsSync(onFtp('.git')), '.git exclu');
});

test('système de fichiers distant : lire, écrire, lister, renommer, supprimer', async () => {
  const profile = api.config.profiles()[0];
  const uri = (p) => vscode.Uri.from({ scheme: 'ftp-sftp-deploy', authority: Buffer.from(profile.id).toString('hex'), path: p });
  assert.strictEqual(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri('/www/index.php'))), '<?php echo "v1";');
  await vscode.workspace.fs.writeFile(uri('/www/new/dir/created.txt'), new TextEncoder().encode('créé'));
  assert.strictEqual(read(onFtp('new/dir/created.txt')), 'créé');
  const entries = await vscode.workspace.fs.readDirectory(uri('/www'));
  assert.ok(entries.some(([n, t]) => n === 'includes' && t === vscode.FileType.Directory));
  await vscode.workspace.fs.rename(uri('/www/new/dir/created.txt'), uri('/www/new/renamed.txt'));
  assert.ok(fs.existsSync(onFtp('new/renamed.txt')));
  await vscode.workspace.fs.delete(uri('/www/new'), { recursive: true });
  assert.ok(!fs.existsSync(onFtp('new')));
  await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(uri('/www/nope.php'))), (e) => e.code === 'FileNotFound');
});

test('recherche de fichiers sur le serveur : liste complète hors exclusions, filtre flou', async () => {
  const profile = api.config.profiles()[0];
  fs.mkdirSync(onFtp('node_modules/lib'), { recursive: true });
  fs.writeFileSync(onFtp('node_modules/lib/x.js'), 'ignored');
  const listing = api.remoteSearch.listing(profile);
  await waitFor(() => listing.done, 'liste des fichiers du serveur');
  assert.ok(!listing.error, listing.error);
  assert.deepStrictEqual([...listing.files].sort(), ['includes/js/app.js', 'index.php']);
  assert.deepStrictEqual(require('../../src/fuzzy').fuzzyFilter('incapp', listing.files), ['includes/js/app.js']);
  // Une écriture sur le serveur par l'extension vide la liste en mémoire : la recherche suivante relit le serveur.
  const uri = vscode.Uri.from({ scheme: 'ftp-sftp-deploy', authority: Buffer.from(profile.id).toString('hex'), path: '/www/found.php' });
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('x'));
  const again = api.remoteSearch.listing(profile);
  await waitFor(() => again.done, 'nouvelle liste');
  assert.ok(again.files.includes('found.php'), again.files.join(', '));
  await vscode.workspace.fs.delete(uri);
  fs.rmSync(onFtp('node_modules'), { recursive: true });
});

test('éditer un fichier distant dans l’éditeur et l’enregistrer', async () => {
  const profile = api.config.profiles()[0];
  const uri = vscode.Uri.from({ scheme: 'ftp-sftp-deploy', authority: Buffer.from(profile.id).toString('hex'), path: '/www/index.php' });
  const editor = await vscode.window.showTextDocument(uri);
  await editor.edit((e) => e.insert(new vscode.Position(0, 0), '// edit\n'));
  await editor.document.save();
  assert.strictEqual(read(onFtp('index.php')), '// edit\n<?php echo "v1";');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
});

test('comparer avec le serveur ouvre un diff serveur ↔ local', async () => {
  await vscode.commands.executeCommand('ftpSftpDeploy.diff', ws('index.php'));
  const tab = await waitFor(() => vscode.window.tabGroups.activeTabGroup.activeTab, 'onglet diff');
  assert.ok(tab.input instanceof vscode.TabInputTextDiff, 'onglet de type diff');
  assert.strictEqual(tab.input.original.scheme, 'ftp-sftp-deploy');
  assert.strictEqual(tab.input.modified.fsPath, ws('index.php').fsPath);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
});

test('télécharger depuis le serveur remplace le fichier local (après confirmation)', async () => {
  fs.writeFileSync(onFtp('includes/js/app.js'), 'console.log("serveur");');
  modals.length = 0;
  await vscode.commands.executeCommand('ftpSftpDeploy.download', ws('includes/js/app.js'));
  assert.strictEqual(modals.length, 1, 'une confirmation demandée');
  assert.strictEqual(read(path.join(WS, 'includes/js/app.js')), 'console.log("serveur");');
  fs.writeFileSync(path.join(WS, 'includes/js/app.js'), 'console.log(1);'); // remet l'état commité
});

test('supprimer du serveur (après confirmation)', async () => {
  fs.writeFileSync(onFtp('to-delete.php'), 'x');
  fs.writeFileSync(path.join(WS, 'to-delete.php'), 'x');
  modals.length = 0;
  await vscode.commands.executeCommand('ftpSftpDeploy.deleteRemote', ws('to-delete.php'));
  assert.ok(/Permanently delete/.test(modals[0] ?? ''), 'confirmation affichée');
  assert.ok(!fs.existsSync(onFtp('to-delete.php')));
  fs.unlinkSync(path.join(WS, 'to-delete.php'));
});

test('changement de profil actif + SFTP + upload à l’enregistrement', async () => {
  await api.config.setActive(vscode.workspace.workspaceFolders[0], 'sftp');
  assert.strictEqual(api.config.forUri(ws('index.php')).name, 'sftp');
  const doc = await vscode.workspace.openTextDocument(ws('index.php'));
  const editor = await vscode.window.showTextDocument(doc);
  await editor.edit((e) => e.replace(new vscode.Range(0, 0, doc.lineCount, 0), '<?php echo "v2";'));
  await doc.save();
  await waitFor(() => fs.existsSync(onSftp('index.php')) && read(onSftp('index.php')) === '<?php echo "v2";', 'upload à l’enregistrement en SFTP');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
});

test('« Déployer tous les fichiers modifiés » : modifiés + nouveaux uploadés, supprimés effacés du serveur', async () => {
  // État serveur SFTP de départ : tout le projet
  await vscode.commands.executeCommand('ftpSftpDeploy.upload', ws(''), [ws('')]);
  assert.ok(fs.existsSync(onSftp('old.php')));

  fs.writeFileSync(path.join(WS, 'includes/js/app.js'), 'console.log(2);');
  fs.writeFileSync(path.join(WS, 'includes/new.php'), 'nouveau');
  fs.unlinkSync(path.join(WS, 'old.php'));

  const repo = vscode.extensions.getExtension('vscode.git').exports.getAPI(1).repositories[0];
  await waitFor(async () => {
    await repo.status();
    const s = repo.state;
    return [...s.workingTreeChanges, ...s.untrackedChanges].length >= 3;
  }, 'git détecte les 3 changements');

  modals.length = 0;
  await vscode.commands.executeCommand('changedFiles.uploadAll');
  assert.ok(/↑ 3 to upload/.test(modals[0]), `récapitulatif : ${modals[0]}`); // index.php (v2), app.js, new.php
  assert.ok(/✕ 1 to delete/.test(modals[0]), 'old.php à supprimer');
  assert.strictEqual(read(onSftp('includes/js/app.js')), 'console.log(2);');
  assert.strictEqual(read(onSftp('includes/new.php')), 'nouveau');
  assert.ok(!fs.existsSync(onSftp('old.php')), 'old.php supprimé du serveur');
  assert.ok(!fs.existsSync(onSftp('debug.log')), 'les exclusions restent appliquées');
});

test('vue « Serveur distant » : arborescence, nouveau dossier, suppression avec confirmation', async () => {
  const roots = await api.remoteTree.getChildren();
  assert.deepStrictEqual(roots.map((r) => r.profile.name), ['ftp', 'sftp']);
  const sftpRoot = roots[1];
  const children = await api.remoteTree.getChildren(sftpRoot);
  const names = children.map((c) => `${c.type}:${c.path}`);
  assert.ok(names[0].startsWith('dir:'), 'dossiers en premier');
  assert.ok(names.includes('dir:/srv/site/includes') && names.includes('file:/srv/site/index.php'), names.join(', '));

  // Nouveau dossier (la saisie du nom est simulée)
  const showInputBox = vscode.window.showInputBox;
  vscode.window.showInputBox = async () => 'nouveau-dossier';
  try {
    await vscode.commands.executeCommand('ftpSftpDeploy.remote.newFolder', sftpRoot);
  } finally {
    vscode.window.showInputBox = showInputBox;
  }
  assert.ok(fs.statSync(onSftp('nouveau-dossier')).isDirectory());

  // Suppression : confirmation obligatoire, puis suppression récursive
  const includes = children.find((c) => c.path === '/srv/site/includes');
  modals.length = 0;
  await vscode.commands.executeCommand('ftpSftpDeploy.remote.delete', includes);
  assert.ok(/Permanently delete the folder "\/srv\/site\/includes" and all its contents/.test(modals[0] ?? ''), modals[0]);
  assert.ok(!fs.existsSync(onSftp('includes')));
});

test('import depuis .vscode/sftp.json : profil créé, mot de passe dans le coffre, connexion OK', async () => {
  const ftpProfile = api.config.profiles().find((p) => p.name === 'ftp');
  fs.writeFileSync(path.join(WS, '.vscode/sftp.json'), JSON.stringify({
    name: 'Mon Site Prod', host: '127.0.0.1', protocol: 'ftp', port: ftpProfile.port,
    username: ftpProfile.username, password: process.env.GMF_PASSWORD, remotePath: '/imported/', uploadOnSave: false,
  }));
  await vscode.commands.executeCommand('ftpSftpDeploy.importSftp');
  const json = JSON.parse(read(path.join(WS, '.vscode/deploy.json')));
  assert.deepStrictEqual(Object.keys(json.profiles), ['mon-site-prod']);
  assert.ok(!('password' in json.profiles['mon-site-prod']), 'pas de mot de passe dans deploy.json');
  const profile = api.config.profiles()[0];
  assert.strictEqual(await api.config.context.secrets.get(api.config.secretKey(profile)), process.env.GMF_PASSWORD);
  await vscode.commands.executeCommand('ftpSftpDeploy.upload', ws('index.php'));
  assert.strictEqual(read(path.join(FTP, 'imported/index.php')), '<?php echo "v2";');
});

test('migration en lot : recherche récursive des sftp.json, deploy.json créés, mots de passe dans le coffre', async () => {
  const projects = process.env.GMF_PROJECTS;
  modals.length = 0;
  const original = { open: vscode.window.showOpenDialog, pick: vscode.window.showQuickPick, info: vscode.window.showInformationMessage };
  let offered;
  vscode.window.showOpenDialog = async () => [vscode.Uri.file(projects)];
  vscode.window.showQuickPick = async (items) => {
    offered = (await items).map((i) => i.label);
    return (await items).filter((i) => i.picked);
  };
  vscode.window.showInformationMessage = async () => undefined;
  try {
    await vscode.commands.executeCommand('ftpSftpDeploy.migrateAll');
  } finally {
    Object.assign(vscode.window, { showOpenDialog: original.open, showQuickPick: original.pick, showInformationMessage: original.info });
  }
  assert.deepStrictEqual(offered, ['client-a', 'group/client-b'], 'node_modules ignoré');
  const a = JSON.parse(read(path.join(projects, 'client-a/.vscode/deploy.json')));
  const b = JSON.parse(read(path.join(projects, 'group/client-b/.vscode/deploy.json')));
  assert.deepStrictEqual(a, { defaultProfile: 'client-a', profiles: { 'client-a': { protocol: 'ftp', host: 'ftp.a.test', port: 21, username: 'ua', remotePath: '/public_html/' } } });
  assert.strictEqual(b.profiles['client-b'].protocol, 'sftp');
  const secret = (profile) => api.config.context.secrets.get(api.config.secretKey(profile));
  assert.strictEqual(await secret(a.profiles['client-a']), 'pa');
  assert.strictEqual(await secret(b.profiles['client-b']), 'pb');
  // La suppression des sftp.json migrés est proposée (validée par le stub avec le 1er bouton)
  assert.ok(modals.some((m) => /Delete the 2 migrated \.vscode\/sftp\.json files/.test(m)), 'suppression proposée');
  assert.ok(!fs.existsSync(path.join(projects, 'client-a/.vscode/sftp.json')), 'sftp.json supprimé');
  assert.ok(!fs.existsSync(path.join(projects, 'group/client-b/.vscode/sftp.json')), 'sftp.json supprimé');
});

test('migration en lot : sélectionner directement le dossier .vscode d’un projet trouve ce projet', async () => {
  const projects = process.env.GMF_PROJECTS;
  const original = { open: vscode.window.showOpenDialog, pick: vscode.window.showQuickPick };
  let offered;
  fs.writeFileSync(path.join(projects, 'group/client-b/.vscode/sftp.json'), '{"name":"b","host":"h"}'); // supprimé par le test précédent
  vscode.window.showOpenDialog = async () => [vscode.Uri.file(path.join(projects, 'group/client-b/.vscode'))];
  vscode.window.showQuickPick = async (items) => {
    offered = (await items).map((i) => `${i.label}|${i.description}`);
    return undefined;
  };
  try {
    await vscode.commands.executeCommand('ftpSftpDeploy.migrateAll');
  } finally {
    Object.assign(vscode.window, { showOpenDialog: original.open, showQuickPick: original.pick });
  }
  assert.deepStrictEqual(offered, ['client-b|deploy.json already exists (will be replaced)']);
});

async function run() {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✔ ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`  ✖ ${t.name}\n      ${err?.stack ?? err}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} tests e2e réussis`);
  if (failed) throw new Error(`${failed} test(s) e2e en échec`);
}

module.exports = { run };
