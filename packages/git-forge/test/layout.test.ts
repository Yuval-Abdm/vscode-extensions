import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GraphLayout, type GraphRow } from '../src/features/graph/layout.ts';

const c = (sha: string, ...parents: string[]) => ({ sha, parents });
/** Forme compacte d'une ligne : colonne, segments entrants et sortants « de→vers ». */
const shape = (row: GraphRow) => ({
  col: row.column,
  up: row.up.map((e) => `${e.from}>${e.to}`).sort().join(' '),
  down: row.down.map((e) => `${e.from}>${e.to}`).sort().join(' '),
});

describe('placement du graphe', () => {
  it('historique linéaire : une seule colonne', () => {
    const rows = new GraphLayout().add([c('c3', 'c2'), c('c2', 'c1'), c('c1')]);
    assert.deepEqual(rows.map(shape), [
      { col: 0, up: '', down: '0>0' },
      { col: 0, up: '0>0', down: '0>0' },
      { col: 0, up: '0>0', down: '' },
    ]);
    assert.ok(rows.every((r) => r.color === rows[0].color && r.width === 1));
  });

  it('merge puis branches qui se rejoignent sur leur parent commun', () => {
    // M(c3, f1) ; f1(c2) ; c3(c2) ; c2(c1) ; c1
    const rows = new GraphLayout().add([c('M', 'c3', 'f1'), c('f1', 'c2'), c('c3', 'c2'), c('c2', 'c1'), c('c1')]);
    assert.deepEqual(rows.map(shape), [
      { col: 0, up: '', down: '0>0 0>1' },
      { col: 1, up: '0>0 1>1', down: '0>0 1>1' },
      { col: 0, up: '0>0 1>1', down: '0>1 1>1' },
      { col: 1, up: '1>1', down: '1>1' },
      { col: 1, up: '1>1', down: '' },
    ]);
    assert.notEqual(rows[0].down.find((e) => e.to === 1)?.color, rows[0].color);
    assert.equal(rows[0].width, 2);
  });

  it('deux pointes de branche sur le même parent', () => {
    // a(p) et b(p) : deux têtes ; p racine
    const rows = new GraphLayout().add([c('a', 'p'), c('b', 'p'), c('p')]);
    assert.deepEqual(rows.map(shape), [
      { col: 0, up: '', down: '0>0' },
      { col: 1, up: '0>0', down: '0>0 1>0' },
      { col: 0, up: '0>0', down: '' },
    ]);
  });

  it('merge octopus et commits racines multiples', () => {
    const rows = new GraphLayout().add([c('O', 'a', 'b', 'c'), c('a'), c('b'), c('c')]);
    assert.deepEqual(rows.map(shape), [
      { col: 0, up: '', down: '0>0 0>1 0>2' },
      { col: 0, up: '0>0 1>1 2>2', down: '1>1 2>2' },
      { col: 1, up: '1>1 2>2', down: '2>2' },
      { col: 2, up: '2>2', down: '' },
    ]);
    assert.equal(rows[0].width, 3);
  });

  it('pagination : la page suivante continue les colonnes ouvertes', () => {
    const layout = new GraphLayout();
    const first = layout.add([c('M', 'x', 'y'), c('y', 'z')]);
    const second = layout.add([c('x', 'z'), c('z')]);
    assert.deepEqual([...first, ...second].map(shape), [
      { col: 0, up: '', down: '0>0 0>1' },
      { col: 1, up: '0>0 1>1', down: '0>0 1>1' },
      { col: 0, up: '0>0 1>1', down: '0>1 1>1' },
      { col: 1, up: '1>1', down: '' },
    ]);
  });
});

describe('nom des voies (couleurs) du graphe', () => {
  type Ref = { name: string; kind: 'head' | 'branch' | 'remote' | 'tag' };
  const n = (sha: string, parents: string[], refs: Ref[] = [], summary = '') => ({ sha, parents, refs, summary });
  /** Noms appris au fil des lignes, par couleur. */
  const learned = (rows: GraphRow[]) => Object.assign({}, ...rows.map((r) => r.names ?? {})) as Record<number, string>;

  it('branche locale préférée à la distante, branche mergée tirée du message de merge', () => {
    const rows = new GraphLayout().add([
      n('M', ['c3', 'f1'], [{ name: 'origin/main', kind: 'remote' }, { name: 'main', kind: 'branch' }], "Merge branch 'feature' into main"),
      n('f1', ['c2']),
      n('c3', ['c2']),
      n('c2', []),
    ]);
    const names = learned(rows);
    assert.equal(names[rows[0].color], 'main');
    assert.equal(names[rows[1].color], 'feature');
    assert.equal(names[rows[2].color], 'main');
  });

  it('voie sans nom au départ : prend la branche du premier commit étiqueté ; tag ignoré', () => {
    const rows = new GraphLayout().add([
      n('x', ['y'], [{ name: 'v1', kind: 'tag' }]),
      n('y', ['z'], [{ name: 'origin/dev', kind: 'remote' }]),
      n('z', [], [{ name: 'other', kind: 'branch' }]),
    ]);
    assert.equal(rows[0].names, undefined);
    assert.deepEqual(rows[1].names, { [rows[0].color]: 'origin/dev' });
    assert.equal(rows[2].names, undefined, 'une voie nommée garde son nom');
  });

  it('pull request GitHub et branche de suivi distante', () => {
    const pr = new GraphLayout().add([n('M', ['a', 'b'], [], 'Merge pull request #12 from yuval/fix-dates'), n('b', ['a']), n('a', [])]);
    assert.equal(learned(pr)[pr[1].color], 'fix-dates');
    const remote = new GraphLayout().add([n('M', ['a', 'b'], [], "Merge remote-tracking branch 'origin/devya'"), n('b', ['a']), n('a', [])]);
    assert.equal(learned(remote)[remote[1].color], 'origin/devya');
  });
});
