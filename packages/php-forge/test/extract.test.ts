import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PhpSymbol } from '../src/shared/types.ts';
import { extract } from './helpers.ts';

const SAMPLE = `<html><?php
namespace App\\Models;
use Foo\\Bar as Baz, Other\\Thing;
use function Lib\\helper;
use const Lib\\MAX;
use Grp\\{A, B as C};
/** Doc for User */
abstract class User extends Base implements \\JsonSerializable, Countable {
    use T1;
    const X = 1, Y = 2;
    private static ?int $count = 0, $other;
    public function __construct(private string $name, int ...$rest) {}
    /** @return static */
    public static function make(array $a = []): static { return new static(); }
}
interface I extends J {}
trait T1 { function t() {} }
enum Suit: string { case Hearts = 'H'; const Z = 1; }
function topFn(&$x, $y = null) { include 'inner.php'; }
define('ROOT_PATH', $_SERVER['DOCUMENT_ROOT']);
const TOP = 3;
include_once(ROOT_PATH . '/x.php');
require 'y.php';
?>
<div><?= $x ?></div>`;

const byName = (name: string, list: PhpSymbol[]) => list.find((s) => s.name === name)!;

describe('extractFile', async () => {
  const file = await extract(SAMPLE);
  const top = (name: string) => byName(name, file.symbols);

  it('portée de namespace et imports (classes, fonctions, constantes, groupes)', () => {
    const scope = file.scopes[1];
    assert.equal(scope.namespace, 'App\\Models');
    assert.deepEqual(scope.uses, {
      class: { baz: 'Foo\\Bar', thing: 'Other\\Thing', a: 'Grp\\A', c: 'Grp\\B' },
      function: { helper: 'Lib\\helper' },
      constant: { MAX: 'Lib\\MAX' },
    });
  });

  it('classe : nom complet, parents résolus, modificateurs, doc, traits, signature', () => {
    const user = top('User');
    assert.equal(user.kind, 'class');
    assert.equal(user.fqn, 'App\\Models\\User');
    assert.deepEqual(user.extends, ['App\\Models\\Base']);
    assert.deepEqual(user.implements, ['JsonSerializable', 'App\\Models\\Countable']);
    assert.deepEqual(user.modifiers, ['abstract']);
    assert.equal(user.doc, 'Doc for User');
    assert.deepEqual(user.uses, ['App\\Models\\T1']);
    assert.equal(user.signature, 'abstract class User extends Base implements \\JsonSerializable, Countable');
  });

  it('membres : constantes, propriétés, méthodes, propriétés promues', () => {
    const members = top('User').children!;
    assert.deepEqual(members.map((c) => `${c.kind}:${c.name}`), [
      'classConstant:X', 'classConstant:Y', 'property:count', 'property:other', 'method:__construct', 'property:name', 'method:make',
    ]);
    const make = byName('make', members);
    assert.equal(make.signature, 'public static function make(array $a = []): static');
    assert.equal(make.doc, '@return static');
    assert.deepEqual(make.modifiers, ['public', 'static']);
    assert.equal(byName('count', members).signature, 'private static ?int $count = 0');
    assert.equal(byName('name', members).signature, 'private string $name');
    assert.equal(byName('X', members).signature, 'const X = 1');
  });

  it('interface, trait, enum', () => {
    assert.deepEqual(top('I').extends, ['App\\Models\\J']);
    assert.equal(top('T1').kind, 'trait');
    const suit = top('Suit');
    assert.equal(suit.signature, 'enum Suit: string');
    assert.deepEqual(suit.children!.map((c) => `${c.kind}:${c.name}`), ['enumCase:Hearts', 'classConstant:Z']);
  });

  it('fonctions et constantes (define global, const dans le namespace)', () => {
    assert.equal(top('topFn').fqn, 'App\\Models\\topFn');
    assert.equal(top('topFn').signature, 'function topFn(&$x, $y = null)');
    assert.equal(top('ROOT_PATH').kind, 'constant');
    assert.equal(top('ROOT_PATH').fqn, 'ROOT_PATH');
    assert.equal(top('TOP').fqn, 'App\\Models\\TOP');
  });

  it('inclusions, y compris dans une fonction, parenthèses retirées', () => {
    assert.deepEqual(file.includes.map((i) => [i.kind, i.expression]), [
      ['include', "'inner.php'"],
      ['include_once', "ROOT_PATH . '/x.php'"],
      ['require', "'y.php'"],
    ]);
  });

  it("pas d'erreur de syntaxe", () => assert.equal(file.syntaxError, false));
});

describe('extractFile : cas particuliers', () => {
  it('namespaces en accolades', async () => {
    const file = await extract('<?php namespace A { class X {} } namespace B { function y() {} }');
    assert.deepEqual(file.symbols.map((s) => s.fqn), ['A\\X', 'B\\y']);
  });

  it("namespace sous forme d'instruction, plusieurs fois", async () => {
    const file = await extract('<?php\nnamespace A;\nclass X {}\nnamespace B;\nclass Y {}');
    assert.deepEqual(file.symbols.map((s) => s.fqn), ['A\\X', 'B\\Y']);
  });

  it('fonction déclarée sous condition, avec sa doc', async () => {
    const file = await extract("<?php if (!function_exists('x')) {\n/** Doc x */\nfunction x() {} }");
    assert.equal(file.symbols[0].fqn, 'x');
    assert.equal(file.symbols[0].doc, 'Doc x');
  });

  it('define : chaînes littérales seulement, casse du mot-clé ignorée', async () => {
    const file = await extract('<?php DEFINE("A", 1); define($name, 2); define("B$x", 3);');
    assert.deepEqual(file.symbols.map((s) => s.fqn), ['A']);
  });

  it('métadonnées de version (stubs)', async () => {
    const file = await extract(
      "<?php\n/**\n * @since 5.3\n * @deprecated\n */\n#[PhpStormStubsElementAvailable(from: '7.0', to: '7.4')]\nfunction f() {}\n/** @removed 8.0 */\nfunction g() {}",
    );
    assert.deepEqual([file.symbols[0].since, file.symbols[0].until, file.symbols[0].deprecated], ['7.0', '7.4', true]);
    assert.equal(file.symbols[1].removed, '8.0');
  });

  it('signature sans les attributs des paramètres', async () => {
    const file = await extract("<?php function strlen(#[LanguageLevelTypeAware(['8.0' => 'string'], default: '')] $string): int {}");
    assert.equal(file.symbols[0].signature, 'function strlen($string): int');
  });

  it('erreur de syntaxe signalée', async () => assert.equal((await extract('<?php class {')).syntaxError, true));
});
