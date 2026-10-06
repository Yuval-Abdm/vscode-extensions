import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canCommit, COMMIT_TYPES, readPrefix, summaryLength, writePrefix } from '../src/features/commit/message.ts';

describe('message de commit conventionnel', () => {
  it('types proposés : conventionnels stricts, chacun avec une icône', () => {
    assert.deepEqual(
      COMMIT_TYPES.map((t) => t.type),
      ['feat', 'fix', 'refactor', 'perf', 'style', 'docs', 'test', 'build', 'ci', 'chore', 'revert'],
    );
    assert.ok(COMMIT_TYPES.every((t) => t.icon.length > 0));
  });

  it('lecture du préfixe : type, scope, breaking, reste du message', () => {
    assert.deepEqual(readPrefix('fix(api)!: corrige le calcul\n\ndétails'), { type: 'fix', scope: 'api', breaking: true, rest: 'corrige le calcul\n\ndétails' });
    assert.deepEqual(readPrefix('feat: ajoute'), { type: 'feat', scope: '', breaking: false, rest: 'ajoute' });
    // Type inconnu : pas un préfixe, le message reste entier.
    assert.deepEqual(readPrefix('wip: essai'), { type: undefined, scope: '', breaking: false, rest: 'wip: essai' });
    assert.deepEqual(readPrefix(''), { type: undefined, scope: '', breaking: false, rest: '' });
  });

  it('écriture du préfixe : ajout, remplacement, retrait, sans toucher au reste', () => {
    assert.equal(writePrefix('corrige le calcul', { type: 'fix', scope: '', breaking: false }), 'fix: corrige le calcul');
    assert.equal(writePrefix('fix: corrige le calcul', { type: 'feat', scope: 'ui', breaking: true }), 'feat(ui)!: corrige le calcul');
    assert.equal(writePrefix('feat(ui)!: corrige', { type: undefined, scope: 'ui', breaking: true }), 'corrige');
    assert.equal(writePrefix('', { type: 'docs', scope: ' readme ', breaking: false }), 'docs(readme): ');
  });

  it('commit possible : au moins un fichier indexé et un texte après le préfixe ; longueur du résumé', () => {
    assert.equal(canCommit('fix: corrige', 1), true);
    assert.equal(canCommit('fix: ', 1), false);
    assert.equal(canCommit('   ', 1), false);
    assert.equal(canCommit('fix: corrige', 0), false);
    assert.equal(summaryLength('fix: abc\nsuite très longue'), 8);
  });
});
