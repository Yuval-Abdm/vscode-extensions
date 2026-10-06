import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PathExpr } from '../src/shared/types.ts';
import { dynamicDirs, evaluatePath, evaluatePrefix, resolveInclude, type ResolveEnv } from '../src/server/includes/resolve.ts';

const FILES = new Set(['/p/inc/b.php', '/p/pages/c.php', '/p/lib/d.php', '/p/x.php']);
const env = (over: Partial<ResolveEnv> = {}): ResolveEnv => ({
  file: '/p/inc/a.php',
  entry: '/p/pages/index.php',
  constant: (name) => (name === 'ROOT_PATH' ? '/p' : undefined),
  docroot: '/p',
  exists: (p) => FILES.has(p),
  serverRoots: [{ remote: '/var/www/site', local: '/p' }],
  roots: ['/p'],
  ...over,
});
const lit = (v: string): PathExpr => ({ k: 'lit', v });

describe('évaluation des chemins', () => {
  it('littéraux, dossier, fichier, DOCUMENT_ROOT, constantes, dirname', () => {
    assert.equal(evaluatePath(lit('a.php'), env()), 'a.php');
    assert.equal(evaluatePath({ k: 'dir' }, env()), '/p/inc');
    assert.equal(evaluatePath({ k: 'file' }, env()), '/p/inc/a.php');
    assert.equal(evaluatePath({ k: 'docroot' }, env()), '/p');
    assert.equal(evaluatePath({ k: 'cat', parts: [{ k: 'const', name: 'ROOT_PATH' }, lit('/x.php')] }, env()), '/p/x.php');
    assert.equal(evaluatePath({ k: 'dirname', of: { k: 'file' }, levels: 2 }, env()), '/p');
  });

  it('inconnu : non évaluable, préfixe gardé', () => {
    const dynamic: PathExpr = { k: 'cat', parts: [{ k: 'const', name: 'ROOT_PATH' }, lit('/templates/'), { k: 'unknown' }, lit('.php')] };
    assert.equal(evaluatePath(dynamic, env()), undefined);
    assert.equal(evaluatePath({ k: 'const', name: 'NOPE' }, env()), undefined);
    assert.equal(evaluatePrefix(dynamic, env()), '/p/templates/');
    assert.deepEqual(dynamicDirs(dynamic, env()), ['/p/templates/']);
    assert.deepEqual(dynamicDirs({ k: 'unknown' }, env()), []);
  });
});

describe('résolution des includes', () => {
  it('chemin absolu, racine du serveur', () => {
    assert.deepEqual(resolveInclude({ k: 'cat', parts: [{ k: 'docroot' }, lit('/x.php')] }, env()), ['/p/x.php']);
    assert.deepEqual(resolveInclude(lit('/var/www/site/lib/d.php'), env()), ['/p/lib/d.php']);
  });

  it('relatif : script d’entrée, puis fichier appelant, puis racines', () => {
    assert.deepEqual(resolveInclude(lit('c.php'), env()), ['/p/pages/c.php']);
    assert.deepEqual(resolveInclude(lit('b.php'), env()), ['/p/inc/b.php']);
    assert.deepEqual(resolveInclude(lit('lib/d.php'), env()), ['/p/lib/d.php']);
    assert.deepEqual(resolveInclude(lit('../x.php'), env()), ['/p/x.php']);
    assert.deepEqual(resolveInclude(lit('b.php'), env({ entry: undefined })), ['/p/inc/b.php']);
  });

  it('introuvable ou non évaluable', () => {
    assert.deepEqual(resolveInclude(lit('missing.php'), env()), []);
    assert.equal(resolveInclude({ k: 'unknown' }, env()), undefined);
    assert.equal(resolveInclude(lit(''), env()), undefined);
  });
});
