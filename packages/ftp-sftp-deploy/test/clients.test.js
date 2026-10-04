// Tests d'intégration des clients FTP et SFTP contre des serveurs locaux réels.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClient, AuthError } = require('../src/clients');
const { startFtp, startSftp, USER, PASSWORD } = require('./servers');

for (const protocol of ['ftp', 'sftp']) {
  describe(`client ${protocol}`, () => {
    let root, server, client, tmp;

    before(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), `gmf-${protocol}-srv-`));
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), `gmf-${protocol}-local-`));
      fs.mkdirSync(path.join(root, 'site/inc'), { recursive: true });
      fs.writeFileSync(path.join(root, 'site/index.php'), '<?php echo 1;');
      fs.writeFileSync(path.join(root, 'site/inc/a.php'), 'A');
      server = protocol === 'ftp' ? await startFtp(root) : await startSftp(root);
      client = createClient({ protocol, host: '127.0.0.1', port: server.port, username: USER, password: PASSWORD });
      await client.connect();
    });

    after(async () => {
      client?.close();
      await server?.close();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('refuse un mauvais mot de passe avec AuthError', async () => {
      const bad = createClient({ protocol, host: '127.0.0.1', port: server.port, username: USER, password: 'nope' });
      await assert.rejects(bad.connect(), AuthError);
      bad.close();
    });

    it('liste un dossier (fichiers et sous-dossiers)', async () => {
      const entries = (await client.list('/site')).map((e) => `${e.type}:${e.name}`).sort();
      assert.deepStrictEqual(entries, ['dir:inc', 'file:index.php']);
    });

    it('stat : fichier, dossier, inexistant, racine', async () => {
      assert.strictEqual((await client.stat('/site/index.php')).type, 'file');
      assert.strictEqual((await client.stat('/site/index.php')).size, 13);
      assert.strictEqual((await client.stat('/site/inc')).type, 'dir');
      assert.strictEqual(await client.stat('/site/nope.php'), null);
      assert.strictEqual(await client.stat('/nope/deeper/x'), null);
      assert.strictEqual((await client.stat('/')).type, 'dir');
    });

    it('lit et écrit un fichier', async () => {
      assert.strictEqual((await client.read('/site/inc/a.php')).toString(), 'A');
      await client.write('/site/inc/b.php', Buffer.from('é B'));
      assert.strictEqual(fs.readFileSync(path.join(root, 'site/inc/b.php'), 'utf8'), 'é B');
    });

    it('mkdirp crée toute l’arborescence, et est idempotent', async () => {
      await client.mkdirp('/site/new/deep/dir');
      await client.mkdirp('/site/new/deep/dir');
      assert.ok(fs.statSync(path.join(root, 'site/new/deep/dir')).isDirectory());
    });

    it('upload et download depuis/vers un fichier local', async () => {
      const local = path.join(tmp, 'up.txt');
      fs.writeFileSync(local, 'x'.repeat(100000));
      await client.upload(local, '/site/new/up.txt');
      assert.strictEqual(fs.statSync(path.join(root, 'site/new/up.txt')).size, 100000);
      const back = path.join(tmp, 'sub/down.txt');
      await client.download('/site/new/up.txt', back);
      assert.strictEqual(fs.readFileSync(back, 'utf8'), 'x'.repeat(100000));
    });

    it('renomme, supprime un fichier puis un dossier non vide', async () => {
      await client.rename('/site/inc/b.php', '/site/inc/c.php');
      assert.ok(fs.existsSync(path.join(root, 'site/inc/c.php')));
      await client.deleteFile('/site/inc/c.php');
      assert.ok(!fs.existsSync(path.join(root, 'site/inc/c.php')));
      await client.deleteDir('/site/new');
      assert.ok(!fs.existsSync(path.join(root, 'site/new')));
    });
  });
}
