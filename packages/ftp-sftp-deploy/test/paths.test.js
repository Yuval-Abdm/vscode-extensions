const { describe, it } = require('node:test');
const assert = require('node:assert');
const { relativeLocal, toRemote, relativeRemote, normalizeRemote, isIgnored, DEFAULT_IGNORE } = require('../src/paths');

describe('paths', () => {
  it('relativeLocal', () => {
    assert.strictEqual(relativeLocal('/w/site', '/w/site/includes/js/a.js'), 'includes/js/a.js');
    assert.strictEqual(relativeLocal('/w/site', '/w/site'), '');
    assert.strictEqual(relativeLocal('/w/site', '/w/other/a.js'), null);
    assert.strictEqual(relativeLocal('/w/site', '/w/site-2/a.js'), null);
  });

  it('toRemote / normalizeRemote', () => {
    assert.strictEqual(toRemote('/public_html/', 'includes/a.php'), '/public_html/includes/a.php');
    assert.strictEqual(toRemote('/public_html', 'a.php'), '/public_html/a.php');
    assert.strictEqual(toRemote('/', 'a.php'), '/a.php');
    assert.strictEqual(toRemote('public_html', ''), '/public_html');
    assert.strictEqual(normalizeRemote(''), '/');
    assert.strictEqual(normalizeRemote('/a//b/'), '/a/b');
  });

  it('relativeRemote', () => {
    assert.strictEqual(relativeRemote('/public_html/', '/public_html/inc/a.php'), 'inc/a.php');
    assert.strictEqual(relativeRemote('/public_html', '/public_html'), '');
    assert.strictEqual(relativeRemote('/public_html', '/etc/passwd'), null);
    assert.strictEqual(relativeRemote('/', '/x/y'), 'x/y');
  });

  it('isIgnored : motifs par segment et par chemin', () => {
    const patterns = [...DEFAULT_IGNORE, '*.log', 'config/secret.php', 'dist/**'];
    assert.ok(isIgnored('.git/config', patterns));
    assert.ok(isIgnored('.vscode/deploy.json', patterns));
    assert.ok(isIgnored('lib/node_modules/x/index.js', patterns));
    assert.ok(isIgnored('logs/error.log', patterns));
    assert.ok(isIgnored('config/secret.php', patterns));
    assert.ok(isIgnored('dist/app.js', patterns));
    assert.ok(!isIgnored('config/app.php', patterns));
    assert.ok(!isIgnored('src/dist.js', patterns));
    assert.ok(!isIgnored('catalog.php', patterns));
    assert.ok(!isIgnored('', patterns));
  });
});
