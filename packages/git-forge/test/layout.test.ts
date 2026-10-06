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
