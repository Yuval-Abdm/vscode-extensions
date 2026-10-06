import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { detectPhpVersion } from '../src/server/settings/phpVersion.ts';
import { loadStubs, STUBS_FORMAT, STUBS_TAG } from '../src/server/stubs/stubs.ts';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/shared/protocol.ts';
import { extract } from './helpers.ts';

const hasPhp = spawnSync('php', ['-v']).status === 0;
const folder = (composer?: object) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'php-forge-version-'));
  if (composer) writeFileSync(path.join(dir, 'composer.json'), JSON.stringify(composer));
  return dir;
};

describe('version de PHP', () => {
  it('réglage explicite', async () => {
    assert.deepEqual(await detectPhpVersion([], '7.3'), { version: '7.3', source: 'setting' });
    assert.deepEqual(await detectPhpVersion([], '8'), { version: '8.0', source: 'setting' });
  });

  it('composer.json : config.platform.php puis require.php', async () => {
    assert.deepEqual(await detectPhpVersion([folder({ require: { php: '>=7.3' } })], ''), { version: '7.3', source: 'composer' });
    assert.deepEqual(await detectPhpVersion([folder({ require: { php: '^7.4|^8.0' } })], ''), { version: '7.4', source: 'composer' });
    assert.deepEqual(await detectPhpVersion([folder({ require: { php: '^8.1' }, config: { platform: { php: '7.4.33' } } })], ''), { version: '7.4', source: 'composer' });
  });

  it('sans composer ni php : 8.3 par défaut', async () => {
    assert.deepEqual(await detectPhpVersion([folder()], '', '/nulle/part/php'), { version: '8.3', source: 'default' });
  });

  it('php installé', { skip: !hasPhp }, async () => {
    const detected = await detectPhpVersion([folder()], '');
    assert.equal(detected.source, 'php');
    assert.match(detected.version, /^\d+\.\d+$/);
  });
});

describe('réglages', () => {
  it('valeurs partielles complétées, inlayHints fusionnés', () => {
    const settings = mergeSettings({ phpVersion: '7.3', inlayHints: { variableTypes: true } as never });
    assert.equal(settings.phpVersion, '7.3');
    assert.deepEqual(settings.inlayHints, { parameterNames: true, variableTypes: true, returnTypes: false });
    assert.deepEqual(settings.exclude, DEFAULT_SETTINGS.exclude);
  });
});

describe('stubs par extension', () => {
  it('seules les extensions demandées sont chargées', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'php-forge-stubs-')), 'stubs.json.gz');
    const files = [
      await extract('<?php function strlen() {}', 'phpstub:/standard/basic.php'),
      await extract('<?php function swoole_version() {}', 'phpstub:/swoole/swoole.php'),
    ];
    writeFileSync(file, gzipSync(JSON.stringify({ format: STUBS_FORMAT, tag: STUBS_TAG, files })));
    const index = loadStubs(file, ['standard']);
    assert.equal(index.findFunction('strlen').length, 1);
    assert.equal(index.findFunction('swoole_version').length, 0);
    assert.equal(loadStubs(file).findFunction('swoole_version').length, 1);
  });
});
