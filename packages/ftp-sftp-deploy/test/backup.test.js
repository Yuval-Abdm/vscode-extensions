// Sauvegarde avant envoi et annulation, contre des serveurs FTP et SFTP locaux réels.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClient } = require('../src/clients');
const { BackupStore } = require('../src/backup');
const { startFtp, startSftp, USER, PASSWORD } = require('./servers');

const profile = { id: 'p1', name: 'prod' };

for (const protocol of ['ftp', 'sftp']) {
  describe(`sauvegarde ${protocol}`, () => {
    let root, server, client, tmp;
    const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
    const exists = (rel) => fs.existsSync(path.join(root, rel));

    before(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), `gmf-bk-${protocol}-srv-`));
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), `gmf-bk-${protocol}-local-`));
      fs.mkdirSync(path.join(root, 'site'), { recursive: true });
      fs.writeFileSync(path.join(root, 'site/a.php'), 'A v1');
      fs.writeFileSync(path.join(root, 'site/old.php'), 'OLD');
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

    const local = (name, content) => {
      const p = path.join(tmp, name);
      fs.writeFileSync(p, content);
      return p;
    };

    it('annule plusieurs envois et une suppression : le serveur revient à son état initial', async () => {
      const store = new BackupStore(path.join(tmp, 'backup'));
      await store.load();
      await store.begin('head1');

      // 1er envoi : modification de a.php + nouveau fichier
      await store.capture(client, profile, '/site/a.php');
      await client.upload(local('a1', 'A v2'), '/site/a.php');
      await store.capture(client, profile, '/site/inc/new.php');
      await client.mkdirp('/site/inc');
      await client.upload(local('n1', 'NEW'), '/site/inc/new.php');
      // 2e envoi de a.php : la version d'origine (v1) reste celle sauvegardée
      await store.capture(client, profile, '/site/a.php');
      await client.upload(local('a2', 'A v3'), '/site/a.php');
      // Suppression distante
      await store.capture(client, profile, '/site/old.php');
      await client.deleteFile('/site/old.php');

      assert.strictEqual(store.entries.length, 3);
      assert.strictEqual(read('site/a.php'), 'A v3');

      // Rechargement depuis le disque (redémarrage de VS Code)
      const reloaded = new BackupStore(path.join(tmp, 'backup'));
      await reloaded.load();
      assert.strictEqual(reloaded.session, 'head1');
      for (const e of reloaded.entries) await reloaded.restore(client, e);
      await reloaded.drop([...reloaded.entries]);

      assert.strictEqual(read('site/a.php'), 'A v1');
      assert.strictEqual(read('site/old.php'), 'OLD');
      assert.ok(!exists('site/inc/new.php'));
      assert.strictEqual(reloaded.entries.length, 0);
      assert.strictEqual(reloaded.session, undefined);
      assert.ok(!fs.existsSync(path.join(tmp, 'backup')));
    });

    it('une nouvelle session repart d’une sauvegarde vide', async () => {
      const store = new BackupStore(path.join(tmp, 'backup2'));
      await store.load();
      await store.begin('head1');
      await store.capture(client, profile, '/site/a.php');
      await store.begin('head1');
      assert.strictEqual(store.entries.length, 1);
      await store.begin('head2');
      assert.strictEqual(store.entries.length, 0);
      assert.strictEqual(store.session, 'head2');
      await store.clear();
    });
  });
}
