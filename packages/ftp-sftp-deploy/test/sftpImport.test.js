const { describe, it } = require('node:test');
const assert = require('node:assert');
const { convertSftpConfig } = require('../src/sftpImport');

describe('convertSftpConfig (sftp.json → deploy.json)', () => {
  it('config FTP simple (format Natizyskunk)', () => {
    const { config, secrets, warnings } = convertSftpConfig({
      name: 'ALL PETITS SITES', host: 'ftp.example.com', protocol: 'ftp', port: 21, username: 'u', password: 'p',
      remotePath: '/site/public_html/', uploadOnSave: false, useTempFile: false, openSsh: false,
    });
    assert.deepStrictEqual(config, {
      defaultProfile: 'all-petits-sites',
      profiles: { 'all-petits-sites': { protocol: 'ftp', host: 'ftp.example.com', port: 21, username: 'u', remotePath: '/site/public_html/' } },
    });
    assert.strictEqual(secrets.length, 1);
    assert.strictEqual(secrets[0].password, 'p');
    assert.strictEqual(secrets[0].profile, config.profiles['all-petits-sites']);
    assert.deepStrictEqual(warnings, []);
  });

  it('SFTP avec clé, ignore, uploadOnSave, timeout ; FTPS implicite', () => {
    const { config } = convertSftpConfig([
      { name: 'api', host: 'h', protocol: 'sftp', username: 'deploy', privateKeyPath: '~/.ssh/id', uploadOnSave: true, ignore: ['.git'], connectTimeout: 5000 },
      { name: 'secure', host: 'h2', secure: 'implicit', username: 'x', secureOptions: { rejectUnauthorized: false } },
    ]);
    assert.deepStrictEqual(config.profiles.api, {
      protocol: 'sftp', host: 'h', port: 22, username: 'deploy', remotePath: '/', privateKeyPath: '~/.ssh/id', uploadOnSave: true, ignore: ['.git'], timeout: 5000,
    });
    assert.deepStrictEqual(config.profiles.secure, { protocol: 'ftps', host: 'h2', port: 990, username: 'x', remotePath: '/', secure: 'implicit', rejectUnauthorized: false });
  });

  it('sous-profils + defaultProfile, noms dédoublonnés, avertissements', () => {
    const { config, warnings } = convertSftpConfig([
      { name: 'Site', host: 'base', username: 'u', defaultProfile: 'prod', context: 'public',
        profiles: { dev: { host: 'dev.host' }, prod: { host: 'prod.host', password: 'pp' } } },
      { name: 'Site', host: 'other' },
      { name: 'sans host' },
    ]);
    assert.deepStrictEqual(Object.keys(config.profiles), ['site-dev', 'site-prod', 'site']);
    assert.strictEqual(config.defaultProfile, 'site-prod');
    assert.strictEqual(config.profiles['site-prod'].host, 'prod.host');
    assert.ok(warnings.some((w) => /context/.test(w)));
    assert.ok(warnings.some((w) => /skipped: no "host"/.test(w)));
  });
});
