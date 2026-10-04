import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { definition } from '../src/server/features/definition.ts';
import { hover, hoverMarkdown } from '../src/server/features/hover.ts';
import { Lookup } from '../src/server/index/lookup.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { extractFile } from '../src/server/model/extract.ts';
import { cursor, extract, parse } from './helpers.ts';

const LIB = `<?php
namespace Lib;
/** A foo */
class Foo extends Base {
  const C = 1;
  public static $count;
  public function bar() {}
  public static function make() {}
}
class Base { protected function escape() {} }
enum Suit { case Hearts; }
function helper() {}
define('ROOT_PATH', '/var/www');`;

/** Index (lib.php + document courant) et stubs ; `current` contient le curseur « | ». */
async function setup(current: string) {
  const workspace = new SymbolIndex();
  workspace.set(await extract(LIB, 'file:///lib.php'));
  const stubs = new SymbolIndex();
  stubs.set(await extract('<?php\n/** Returns string length */\nfunction strlen(string $string): int {}', 'phpstub:/standard/basic.php'));
  const { text, position } = cursor(current);
  const tree = await parse(text);
  const file = extractFile(tree, 'file:///current.php');
  workspace.set(file);
  return { lookup: new Lookup(workspace, stubs), file, tree, position };
}

async function targets(current: string): Promise<string[]> {
  const s = await setup(current);
  return definition(s.lookup, s.file, s.tree, s.position).map((l) => `${l.uri.replace('file:///', '')}:${l.range.start.line}`);
}

describe('definition', () => {
  it('classe via un alias use', async () => assert.deepEqual(await targets('<?php namespace App; use Lib\\Foo as F; new F|();'), ['lib.php:3']));
  it('nom dans une instruction use', async () => assert.deepEqual(await targets('<?php namespace App; use Lib\\Fo|o;'), ['lib.php:3']));
  it('méthode statique', async () => assert.deepEqual(await targets('<?php use Lib\\Foo; Foo::ma|ke();'), ['lib.php:7']));
  it('constante de classe', async () => assert.deepEqual(await targets('<?php use Lib\\Foo; echo Foo::|C;'), ['lib.php:4']));
  it('propriété statique', async () => assert.deepEqual(await targets('<?php use Lib\\Foo; echo Foo::$co|unt;'), ['lib.php:5']));
  it("cas d'enum", async () => assert.deepEqual(await targets('<?php use Lib\\Suit; Suit::Hea|rts;'), ['lib.php:10']));
  it('$this-> : méthode héritée', async () => {
    assert.deepEqual(await targets('<?php namespace Lib; class Child extends Foo { function m() { $this->esc|ape(); } }'), ['lib.php:9']);
  });
  it('parent::', async () => {
    assert.deepEqual(await targets('<?php namespace Lib; class Child extends Foo { function m() { parent::ba|r(); } }'), ['lib.php:6']);
  });
  it('self::', async () => {
    assert.deepEqual(await targets('<?php namespace Lib; class Child extends Foo { function m() { self::|C; } }'), ['lib.php:4']);
  });
  it('objet de type inconnu : toutes les méthodes de ce nom', async () => assert.deepEqual(await targets('<?php $x->ba|r();'), ['lib.php:6']));
  it('use function', async () => assert.deepEqual(await targets('<?php use function Lib\\helper; help|er();'), ['lib.php:11']));
  it('fonction du namespace courant', async () => assert.deepEqual(await targets('<?php namespace Lib; help|er();'), ['lib.php:11']));
  it('constante définie par define', async () => assert.deepEqual(await targets('<?php echo ROOT_PA|TH;'), ['lib.php:12']));
  it('nom d’une déclaration : elle-même', async () => assert.deepEqual(await targets('<?php namespace Lib; class Fo|o2 {}'), ['current.php:0']));
  it('fonction native : pas de fichier à ouvrir', async () => assert.deepEqual(await targets("<?php str|len('a');"), []));
  it('type natif ou rien sous le curseur', async () => {
    assert.deepEqual(await targets('<?php function f(in|t $a) {}'), []);
    assert.deepEqual(await targets('<?php echo 1|;'), []);
  });
});

describe('hover', () => {
  it('fonction native : signature et doc', async () => {
    const s = await setup("<?php str|len('a');");
    const value = (hover(s.lookup, s.file, s.tree, s.position)!.contents as { value: string }).value;
    assert.match(value, /function strlen\(string \$string\): int/);
    assert.match(value, /Returns string length/);
  });

  it('classe : namespace, signature, doc', async () => {
    const s = await setup('<?php use Lib\\Foo; new Fo|o();');
    const value = (hover(s.lookup, s.file, s.tree, s.position)!.contents as { value: string }).value;
    assert.match(value, /namespace Lib;\nclass Foo extends Base/);
    assert.match(value, /A foo/);
  });

  it('rien sous le curseur : null', async () => {
    const s = await setup('<?php echo 1|;');
    assert.equal(hover(s.lookup, s.file, s.tree, s.position), null);
  });

  it('versions, obsolescence, autres déclarations', () => {
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    const value = hoverMarkdown({ kind: 'function', name: 'f', signature: 'function f()', deprecated: true, since: '7.0', removed: '8.0', range, selectionRange: range }, 2);
    assert.match(value, /\*\*Deprecated\*\*/);
    assert.match(value, /Available since PHP 7\.0/);
    assert.match(value, /Removed in PHP 8\.0/);
    assert.match(value, /1 other declarations/);
  });
});
