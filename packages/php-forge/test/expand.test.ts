import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Lookup } from '../src/server/index/lookup.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { extractFile } from '../src/server/model/extract.ts';
import { compareVersions, isAvailable } from '../src/server/stubs/availability.ts';
import { bindingAt, TypeResolver } from '../src/server/types/expand.ts';
import { Inferrer } from '../src/server/types/infer.ts';
import { formatType } from '../src/server/types/type.ts';
import { cursor, expressionAt, extract, parse } from './helpers.ts';

const LIB = `<?php
namespace Lib;
/** @template T */
class Collection {
  /** @return T */
  public function first() {}
  public function filter(): static {}
  /** @var T[] */
  public array $items = [];
}
/** @extends Collection<User> */
class UserCollection extends Collection {}
class User {
  public ?Address $address;
  public function name(): string {}
  public static function find(int $id): ?static {}
  public function me(): self {}
}
class Admin extends User { public function name(): string {} }
class Address { public string $city; }
enum Status: string { case Active = 'a'; }
class LoopA extends LoopB {}
class LoopB extends LoopA {}
/**
 * @template T
 * @param class-string<T> $class
 * @return T
 */
function make(string $class) {}
function users(): UserCollection {}
`;

const STUBS = `<?php
#[PhpStormStubsElementAvailable(to: '7.4')]
function old(): int {}
#[PhpStormStubsElementAvailable(from: '8.0')]
function old(): string {}
`;

async function typeAt(code: string, version = '8.3'): Promise<string> {
  const workspace = new SymbolIndex();
  workspace.set(await extract(LIB, 'file:///lib.php'));
  const stubs = new SymbolIndex();
  stubs.set(await extract(STUBS, 'phpstub:/standard/s.php'));
  const { text, position } = cursor(code);
  const tree = await parse(text);
  const file = extractFile(tree, 'file:///current.php');
  workspace.set(file);
  const resolver = new TypeResolver(new Lookup(workspace, stubs), version);
  const node = expressionAt(tree, position);
  return formatType(resolver.expand(new Inferrer(file.scopes).expr(node), bindingAt(node, file.scopes)));
}

describe('TypeResolver', () => {
  it('template de classe lié par @extends', async () => {
    assert.equal(await typeAt('<?php use Lib\\UserCollection; $c = new UserCollection(); |$c->first();'), 'User');
  });

  it('static : la classe de l’objet', async () => {
    assert.equal(await typeAt('<?php use Lib\\UserCollection; $c = new UserCollection(); |$c->filter();'), 'UserCollection');
    assert.equal(await typeAt('<?php use Lib\\Admin; |Admin::find(1);'), '?Admin');
  });

  it('self : la classe qui déclare', async () => {
    assert.equal(await typeAt('<?php use Lib\\Admin; $a = new Admin(); |$a->me();'), 'User');
  });

  it('chaîne de propriétés', async () => {
    assert.equal(await typeAt('<?php use Lib\\User; $u = new User(); |$u->address->city;'), 'string');
  });

  it('template de fonction lié par class-string', async () => {
    assert.equal(await typeAt('<?php use Lib\\User; use function Lib\\make; |make(User::class);'), 'User');
  });

  it('retour de fonction puis méthode', async () => {
    assert.equal(await typeAt('<?php use function Lib\\users; |users()->first();'), 'User');
  });

  it('cas d’enum', async () => {
    assert.equal(await typeAt('<?php use Lib\\Status; |Status::Active;'), 'Status');
  });

  it('élément d’un tableau générique dans un foreach', async () => {
    assert.equal(await typeAt('<?php use Lib\\UserCollection; $c = new UserCollection(); foreach ($c->items as $u) { |$u; }'), 'User');
  });

  it('$this dans une méthode', async () => {
    assert.equal(await typeAt('<?php namespace Lib; class Child extends User { function f() { |$this->name(); } }'), 'string');
    assert.equal(await typeAt('<?php namespace Lib; class Child extends User { function f() { |$this; } }'), 'Child');
  });

  it('variante de stub selon la version de PHP', async () => {
    assert.equal(await typeAt('<?php |old();', '7.3'), 'int');
    assert.equal(await typeAt('<?php |old();', '8.1'), 'string');
  });

  it('héritage circulaire : mixed, sans boucle', async () => {
    assert.equal(await typeAt('<?php use Lib\\LoopA; $a = new LoopA(); |$a->missing();'), 'mixed');
  });

  it('membre redéfini : la déclaration la plus proche seulement', async () => {
    const workspace = new SymbolIndex();
    workspace.set(await extract(LIB, 'file:///lib.php'));
    const resolver = new TypeResolver(new Lookup(workspace, new SymbolIndex()));
    const hits = resolver.findMember({ fqn: 'Lib\\Admin' }, 'name', ['method']);
    assert.deepEqual(hits.map((h) => h.owner.symbol.fqn), ['Lib\\Admin']);
  });
});

describe('versions de PHP', () => {
  it('compareVersions', () => {
    assert.equal(compareVersions('7.4', '8.0'), -1);
    assert.equal(compareVersions('8.0', '8'), 0);
    assert.equal(compareVersions('8.1.2', '8.1'), 1);
  });

  it('isAvailable : since, until, removed', () => {
    const at = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    const symbol = { kind: 'function' as const, name: 'f', range: at, selectionRange: at };
    assert.equal(isAvailable({ ...symbol, since: '8.0' }, '7.3'), false);
    assert.equal(isAvailable({ ...symbol, since: '8.0' }, '8.0'), true);
    assert.equal(isAvailable({ ...symbol, until: '7.4' }, '8.0'), false);
    assert.equal(isAvailable({ ...symbol, removed: '7.0' }, '7.0'), false);
    assert.equal(isAvailable({ ...symbol, removed: '7.0' }, '5.6'), true);
    assert.equal(isAvailable({ ...symbol, removed: '7.0' }), true);
  });
});
