import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Lookup } from '../src/server/index/lookup.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { extract } from './helpers.ts';

describe('SymbolIndex', () => {
  it('classes et fonctions sans casse, constantes : namespace sans casse, nom exact', async () => {
    const index = new SymbolIndex();
    index.set(await extract('<?php namespace App; class User {} function helper() {} const MAX = 1; define("ROOT", 1);', 'file:///a.php'));
    assert.equal(index.findClass('app\\USER')[0].symbol.name, 'User');
    assert.equal(index.findFunction('APP\\Helper').length, 1);
    assert.equal(index.findConstant('app\\MAX').length, 1);
    assert.equal(index.findConstant('App\\max').length, 0);
    assert.equal(index.findConstant('ROOT')[0].uri, 'file:///a.php');
  });

  it('remplacer un fichier retire ses anciens symboles', async () => {
    const index = new SymbolIndex();
    index.set(await extract('<?php class A {}', 'file:///a.php'));
    index.set(await extract('<?php class B {}', 'file:///a.php'));
    assert.equal(index.findClass('A').length, 0);
    assert.equal(index.findClass('B').length, 1);
    assert.equal(index.size, 1);
  });

  it('même classe dans deux fichiers, puis suppression de l’un', async () => {
    const index = new SymbolIndex();
    index.set(await extract('<?php class A {}', 'file:///a.php'));
    index.set(await extract('<?php class A {}', 'file:///b.php'));
    assert.equal(index.findClass('A').length, 2);
    index.delete('file:///a.php');
    assert.deepEqual(index.findClass('A').map((h) => h.uri), ['file:///b.php']);
  });
});

describe('Lookup', () => {
  async function lookup(): Promise<Lookup> {
    const workspace = new SymbolIndex();
    workspace.set(await extract(`<?php
      trait Greets { public function hello() {} }
      class Base { const C = 1; protected function escape() {} public static $count; }
      class Child extends Base implements Shape { use Greets; public function RENDER() {} }
      interface Shape { function area(); }
      class LoopA extends LoopB {}
      class LoopB extends LoopA {}`, 'file:///m.php'));
    const stubs = new SymbolIndex();
    stubs.set(await extract('<?php function strlen($s) {} class Base {}', 'phpstub:/standard/s.php'));
    return new Lookup(workspace, stubs);
  }

  it('le workspace avant les stubs', async () => {
    const l = await lookup();
    assert.deepEqual(l.findClass('Base').map((h) => h.uri), ['file:///m.php', 'phpstub:/standard/s.php']);
    assert.equal(l.findFunction('strlen').length, 1);
  });

  it('membres hérités (parent, trait, interface), méthodes sans casse, propriétés avec casse', async () => {
    const l = await lookup();
    assert.equal(l.findMembers('Child', 'render', ['method'])[0].symbol.name, 'RENDER');
    assert.equal(l.findMembers('Child', 'escape', ['method']).length, 1);
    assert.equal(l.findMembers('Child', 'hello', ['method']).length, 1);
    assert.equal(l.findMembers('Child', 'area', ['method']).length, 1);
    assert.equal(l.findMembers('Child', 'C', ['classConstant']).length, 1);
    assert.equal(l.findMembers('Child', 'count', ['property']).length, 1);
    assert.equal(l.findMembers('Child', 'COUNT', ['property']).length, 0);
  });

  it('héritage circulaire : pas de boucle infinie', async () => {
    assert.equal([...(await lookup()).ancestors('LoopA')].length, 2);
  });

  it('membres sans propriétaire connu', async () => {
    assert.equal((await lookup()).findMembersAnywhere('escape', ['method']).length, 1);
  });
});
