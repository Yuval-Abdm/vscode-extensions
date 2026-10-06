import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Lru } from '../src/git/cache.ts';

describe('Lru', () => {
  it("évince l'entrée la moins récemment lue", () => {
    const lru = new Lru<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    assert.equal(lru.get('a'), 1); // « a » redevient récente
    lru.set('c', 3);
    assert.equal(lru.get('b'), undefined);
    assert.equal(lru.get('a'), 1);
    assert.equal(lru.get('c'), 3);
    assert.equal(lru.size, 2);
  });

  it('remplace une valeur existante sans dépasser la taille', () => {
    const lru = new Lru<string, number>(2);
    lru.set('a', 1);
    lru.set('a', 2);
    assert.equal(lru.size, 1);
    assert.equal(lru.get('a'), 2);
  });

  it('delete et clear', () => {
    const lru = new Lru<string, number>(3);
    lru.set('a', 1);
    lru.set('b', 2);
    assert.equal(lru.delete('a'), true);
    assert.equal(lru.get('a'), undefined);
    lru.clear();
    assert.equal(lru.size, 0);
  });
});
