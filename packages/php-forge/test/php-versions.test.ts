import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { versionChoices } from '../src/client/phpVersions.ts';

describe('choix de la version de PHP', () => {
  it('détection automatique en tête (version détectée et source), puis les versions, la courante marquée', () => {
    const items = versionChoices({ phpVersion: '7.3', source: 'composer' }, '');
    assert.deepEqual(items[0], { value: '', current: true, detected: '7.3', source: 'composer' });
    assert.deepEqual(items.slice(1).map((i) => i.value), ['8.4', '8.3', '8.2', '8.1', '8.0', '7.4', '7.3', '7.2', '7.1', '7.0', '5.6']);
    assert.ok(items.slice(1).every((i) => !i.current));
  });

  it('version imposée par le réglage : marquée ; version absente de la liste ajoutée', () => {
    const items = versionChoices({ phpVersion: '7.4', source: 'setting' }, '7.4');
    assert.equal(items.find((i) => i.current)?.value, '7.4');
    assert.equal(items[0].current, false);
    assert.ok(versionChoices({ phpVersion: '5.4', source: 'setting' }, '5.4').some((i) => i.value === '5.4' && i.current));
  });
});
