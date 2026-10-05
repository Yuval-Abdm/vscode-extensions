import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { semanticDiagnostics } from '../src/server/diagnostics/semantic.ts';
import { Lookup } from '../src/server/index/lookup.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { TypeResolver } from '../src/server/types/expand.ts';
import { extract, parse } from './helpers.ts';

const STUBS = `<?php
function strlen(string $s): int {}
/** @since 8.0 */
function str_contains(string $h, string $n): bool {}
/** @removed 7.0 */
function mysql_query($q) {}
#[Deprecated(since: '7.2')]
function each(array &$a) {}
function sprintf(string $f, mixed ...$v): string {}
function function_exists(string $f): bool {}
function class_exists(string $c): bool {}
function defined(string $n): bool {}
function func_get_args(): array {}
function get_obj_stub() {}
class Exception { public function getMessage(): string {} }
class stdClass {}
define('PHP_EOL', "\\n");
`;

async function check(code: string, version = '8.3', others: Record<string, string> = {}) {
  const workspace = new SymbolIndex();
  const uri = 'file:///p/page.php';
  for (const [name, text] of Object.entries(others)) workspace.set(await extract(text, `file:///p/${name}`));
  const tree = await parse(code);
  const file = await extract(code, uri);
  workspace.set(file);
  const stubs = new SymbolIndex();
  stubs.set(await extract(STUBS, 'phpstub:/standard/standard.php'));
  const resolver = new TypeResolver(new Lookup(workspace, stubs), version);
  return semanticDiagnostics(file, tree, resolver).map((d) => `${d.range.start.line}:${d.code} ${d.message}`);
}

describe('symboles introuvables', () => {
  it('fonction, classe, constante inconnues', async () => {
    assert.deepEqual(await check('<?php\nnope();\nnew Missing();\necho NOPE_CONST;\nstrlen("x");\necho PHP_EOL;\n'), [
      '1:undefined-function Call to undefined function nope()',
      '2:undefined-class Class Missing does not exist',
      '3:undefined-constant Undefined constant NOPE_CONST',
    ]);
  });

  it('instanceof, argument nommé, type de paramètre : pas des constantes', async () => {
    assert.deepEqual(await check('<?php\nfunction f(int $a = 1) {}\nif ($x instanceof Nope) {}\nf(a: 2);\n'), []);
  });

  it('or die, clés non entre guillemets dans une chaîne : pas des constantes', async () => {
    assert.deepEqual(await check('<?php\n$r = f2() or die;\necho "$a[key] {$b[k2]}";\n', '8.3', { 'f.php': '<?php function f2() {}' }), []);
  });

  it('classe dans un fichier avec une erreur de syntaxe (membres peut-être perdus) : pas d’alerte de membre', async () => {
    const others = { 'big.php': '<?php class Big { function a() { $x = ; } function b() {} }' };
    assert.deepEqual(await check('<?php\n$o = new Big();\n$o->b();\n$o->c();\n', '8.3', others), []);
  });

  it('classe déclarée dans plusieurs fichiers (versions) : pas d’alerte de membre', async () => {
    const others = { 'a.php': '<?php class Dup { function a() {} }', 'b.php': '<?php class Dup { function b() {} }' };
    assert.deepEqual(await check('<?php\n$d = new Dup();\n$d->a();\n$d->b();\n', '8.3', others), []);
  });

  it('gardes function_exists / class_exists / defined', async () => {
    assert.deepEqual(await check("<?php\nif (function_exists('nope')) { nope(); }\nif (class_exists('Missing')) { new Missing(); }\nif (defined('X') && X) {}\nfunction_exists('g') && g();\n"), []);
  });

  it('symboles du workspace, namespaces et use', async () => {
    const code = '<?php\nnamespace App;\nuse Lib\\Tool;\nnew Tool();\nhelper();\nstrlen("x");\n\\strlen("y");\n';
    assert.deepEqual(await check(code, '8.3', { 'lib.php': '<?php\nnamespace Lib;\nclass Tool {}\n', 'h.php': '<?php\nnamespace App;\nfunction helper() {}\n' }), []);
  });

  it('extends, implements, appel statique, constante de classe', async () => {
    assert.deepEqual(await check('<?php\nclass A extends Base implements Iface {}\nGone::run();\necho Gone::X;\n'), [
      '1:undefined-class Class Base does not exist',
      '1:undefined-class Class Iface does not exist',
      '2:undefined-class Class Gone does not exist',
      '3:undefined-class Class Gone does not exist',
    ]);
  });
});

describe('API selon la version de PHP', () => {
  it('fonction trop récente, supprimée, dépréciée', async () => {
    assert.deepEqual(await check('<?php\nstr_contains("a", "b");\nmysql_query("x");\n$t = [];\neach($t);\n', '7.3'), [
      '1:undefined-function str_contains() is not available in PHP 7.3 (added in PHP 8.0)',
      '2:removed-api mysql_query() was removed in PHP 7.0',
      '4:deprecated-api each() is deprecated since PHP 7.2',
    ]);
    assert.deepEqual(await check('<?php\nstr_contains("a", "b");\n', '8.3'), []);
  });
});

describe('membres sur un type connu', () => {
  it('méthode et propriété inexistantes', async () => {
    const code = '<?php\nclass A { public $p; function m() {} }\n$a = new A();\n$a->m();\n$a->nope();\necho $a->p;\necho $a->q;\n$a->created = 1;\n';
    assert.deepEqual(await check(code), [
      '4:undefined-method Method A::nope() does not exist',
      '6:undefined-property Property A::$q does not exist',
    ]);
  });

  it('type inconnu, __call, __get, propriétés dynamiques, stdClass, @mixin : rien', async () => {
    const code = [
      '<?php',
      'class M { function __call($n, $a) {} function __get($n) {} }',
      'class D { function __construct() { $this->made = 1; } function f() { return $this->made; } }',
      '/** @mixin D */ class X {}',
      '$m = new M(); $m->any(); echo $m->prop;',
      '$o = get_obj(); $o->whatever();',
      '$s = new stdClass(); echo $s->x;',
      '$x = new X(); $x->f();',
    ].join('\n');
    assert.deepEqual(await check(code, '8.3', { 'f.php': '<?php function get_obj() { return null; }' }), []);
  });

  it('classe parente introuvable : pas d’alerte de membre', async () => {
    assert.deepEqual((await check('<?php\nclass A extends Unknown {}\n$a = new A();\n$a->fromParent();\n')).filter((d) => !d.includes('undefined-class')), []);
  });

  it('méthode statique, self, parent', async () => {
    const code = '<?php\nclass P { static function s() {} }\nclass C extends P { function m() { self::s(); parent::s(); static::nope(); } }\nC::s();\nC::gone();\n';
    assert.deepEqual(await check(code), [
      '2:undefined-method Method C::nope() does not exist',
      '4:undefined-method Method C::gone() does not exist',
    ]);
  });
});

describe('nombre d’arguments', () => {
  it('fonctions et méthodes du projet', async () => {
    const code = [
      '<?php',
      'function two($a, $b = 1) {}',
      'function rest($a, ...$r) {}',
      'function legacy() { return func_get_args(); }',
      'class K { function __construct($x) {} function m($a) {} }',
      'two(); two(1); two(1, 2); two(1, 2, 3);',
      'rest(1, 2, 3, 4); legacy(1, 2);',
      '$k = new K(); $k->m(); $k->m(1, 2);',
      'new K(1);',
      'two(...$args); two(a: 1);',
      'strlen("a", "b");',
    ].join('\n');
    assert.deepEqual(await check(code), [
      '5:argument-count Too few arguments to two(): 0 given, at least 1 expected',
      '5:argument-count Too many arguments to two(): 3 given, at most 2 expected',
      '7:argument-count Too few arguments to new K(): 0 given, at least 1 expected',
      '7:argument-count Too few arguments to K::m(): 0 given, at least 1 expected',
      '7:argument-count Too many arguments to K::m(): 2 given, at most 1 expected',
    ]);
  });
});
