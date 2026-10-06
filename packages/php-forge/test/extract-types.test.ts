import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PhpSymbol } from '../src/shared/types.ts';
import { formatType } from '../src/server/types/type.ts';
import { extract } from './helpers.ts';

const CODE = `<?php
namespace App;
use Lib\\User;
/**
 * @param string[] $tags
 * @param int ...$ids
 * @return User[]
 */
function search(array $tags, ?int &$count = null, int ...$ids): array {}
/**
 * @template T
 * @param class-string<T> $class
 * @return T
 */
function make(string $class) {}
/**
 * @template T
 * @extends Base<T>
 * @mixin \\Lib\\Helper
 * @property-read int $id
 * @method static self create(array $data = [])
 */
class Repo extends Base {
  /** @var User[] */
  private array $items = [];
  protected ?User $current;
  public function __construct(private readonly \\PDO $db) {}
  /** @return T|null */
  public function first() {}
}
enum Suit: string { case H = 'h'; }
enum Plain { case A; }
#[LanguageLevelTypeAware(['8.0' => 'string'], default: 'string|false')]
function stubby(#[LanguageLevelTypeAware(['8.0' => 'int'], default: '')] $x) {}
`;

const byName = (name: string, list: PhpSymbol[]) => list.find((s) => s.name === name)!;
const show = (symbol: PhpSymbol) => (symbol.type ? formatType(symbol.type) : undefined);

describe('extraction des types', async () => {
  const file = await extract(CODE);
  const top = (name: string) => byName(name, file.symbols);

  it('paramètres : types déclarés et phpdoc, référence, valeur par défaut, variadique', () => {
    const params = top('search').params!;
    assert.deepEqual(params.map((p) => [p.name, p.type && formatType(p.type), p.byRef ?? false, p.variadic ?? false, p.defaultValue]), [
      ['tags', 'string[]', false, false, undefined],
      ['count', '?int', true, false, 'null'],
      ['ids', 'int', false, true, undefined],
    ]);
  });

  it('type de retour : la phpdoc précise un array déclaré', () => {
    assert.equal(show(top('search')), 'User[]');
    assert.deepEqual(top('search').type, { kind: 'array', value: { kind: 'class', fqn: 'Lib\\User' } });
  });

  it('templates de fonction et class-string<T>', () => {
    const make = top('make');
    assert.deepEqual(make.templates, ['T']);
    assert.deepEqual(make.params![0].type, { kind: 'classString', template: 'T' });
    assert.deepEqual(make.type, { kind: 'template', name: 'T' });
  });

  it('classe : templates, @extends générique, @mixin, membres virtuels', () => {
    const repo = top('Repo');
    assert.deepEqual(repo.templates, ['T']);
    assert.deepEqual(repo.parentArgs, { 'app\\base': [{ kind: 'template', name: 'T' }] });
    assert.deepEqual(repo.mixins, ['Lib\\Helper']);
    const id = byName('id', repo.children!);
    assert.equal(id.virtual, true);
    assert.equal(show(id), 'int');
    const create = byName('create', repo.children!);
    assert.equal(create.virtual, true);
    assert.deepEqual(create.modifiers, ['public', 'static']);
    assert.equal(show(create), 'self');
    assert.deepEqual(create.params, [{ name: 'data', type: { kind: 'array' }, defaultValue: '[]' }]);
  });

  it('propriétés : @var, type déclaré, propriétés promues', () => {
    const repo = top('Repo');
    assert.equal(show(byName('items', repo.children!)), 'User[]');
    assert.equal(show(byName('current', repo.children!)), '?User');
    assert.equal(show(byName('db', repo.children!)), 'PDO');
    assert.equal(show(byName('first', repo.children!)), '?T');
  });

  it('enums : UnitEnum ou BackedEnum', () => {
    assert.deepEqual(top('Suit').implements, ['BackedEnum']);
    assert.deepEqual(top('Plain').implements, ['UnitEnum']);
  });

  it('stubs : type de la version la plus récente (LanguageLevelTypeAware)', () => {
    assert.equal(show(top('stubby')), 'string');
    assert.equal(formatType(top('stubby').params![0].type!), 'int');
  });
});
