import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractFile } from '../src/server/model/extract.ts';
import { Inferrer } from '../src/server/types/infer.ts';
import { formatType } from '../src/server/types/type.ts';
import type { TypeExpr } from '../src/shared/types.ts';
import { cursor, expressionAt, parse } from './helpers.ts';

/** Affichage avec les types différés lisibles (noms complets des classes). */
function show(type: TypeExpr): string {
  switch (type.kind) {
    case 'ref': {
      const r = type.ref;
      switch (r.of) {
        case 'function': return `fn(${r.names.join('|')})`;
        case 'constant': return `const(${r.names.join('|')})`;
        case 'method': return `${show(r.on)}->${r.name}()`;
        case 'property': return `${show(r.on)}->${r.name}`;
        case 'classConstant': return `${show(r.on)}::${r.name}`;
        case 'element': return `element(${show(r.on)})`;
        case 'key': return `key(${show(r.on)})`;
        case 'offset': return `${show(r.on)}[${r.key ?? '?'}]`;
      }
    }
    case 'union': return type.types.map(show).join('|');
    case 'class': return type.fqn;
    default: return formatType(type);
  }
}

/** Type de l'expression qui commence au curseur « | ». */
async function typeAt(code: string): Promise<string> {
  const { text, position } = cursor(code);
  const tree = await parse(text);
  const file = extractFile(tree, 'file:///test.php');
  return show(new Inferrer(file.scopes).expr(expressionAt(tree, position)));
}

describe('Inferrer : littéraux et opérateurs', () => {
  it('scalaires', async () => {
    assert.equal(await typeAt('<?php $a = 1; |$a;'), 'int');
    assert.equal(await typeAt('<?php $a = 1.5; |$a;'), 'float');
    assert.equal(await typeAt("<?php $a = 'x'; |$a;"), 'string');
    assert.equal(await typeAt('<?php $a = true; |$a;'), 'bool');
    assert.equal(await typeAt('<?php $a = null; |$a;'), 'null');
    assert.equal(await typeAt('<?php $a = "v $b"; |$a;'), 'string');
    assert.equal(await typeAt('<?php |__LINE__;'), 'int');
    assert.equal(await typeAt('<?php |__DIR__;'), 'string');
  });

  it('tableaux : liste, forme, vide', async () => {
    assert.equal(await typeAt('<?php $a = [1, 2]; |$a;'), 'list<int>');
    assert.equal(await typeAt("<?php $a = ['id' => 1, 'name' => 'x']; |$a;"), 'array{id: int, name: string}');
    assert.equal(await typeAt('<?php $a = []; |$a;'), 'array');
  });

  it('opérateurs', async () => {
    assert.equal(await typeAt("<?php |'a' . 1;"), 'string');
    assert.equal(await typeAt('<?php |1 + 2;'), 'int');
    assert.equal(await typeAt('<?php |1 + 2.5;'), 'float');
    assert.equal(await typeAt('<?php |$x === 1;'), 'bool');
    assert.equal(await typeAt('<?php |!$x;'), 'bool');
    assert.equal(await typeAt('<?php |(int) $s;'), 'int');
    assert.equal(await typeAt("<?php $a = 1; |$a ?? 'x';"), 'int|string');
    assert.equal(await typeAt("<?php |$c ? 1 : 'x';"), 'int|string');
    assert.equal(await typeAt("<?php |match ($x) { 1 => 'a', default => null };"), 'string|null');
  });
});

describe('Inferrer : variables', () => {
  it('la dernière affectation l’emporte', async () => {
    assert.equal(await typeAt('<?php $a = 1; $a = "x"; |$a;'), 'string');
  });

  it('affectation conditionnelle : union avec la précédente', async () => {
    assert.equal(await typeAt('<?php $a = 1; if ($c) { $a = "x"; } |$a;'), 'string|int');
  });

  it('dans la branche : seulement sa propre affectation', async () => {
    assert.equal(await typeAt('<?php $a = 1; if ($c) { $a = "x"; |$a; }'), 'string');
  });

  it('paramètres : déclarés, phpdoc, variadiques', async () => {
    assert.equal(await typeAt('<?php /** @param string[] $list */ function f(int $n, array $list) { |$list; }'), 'string[]');
    assert.equal(await typeAt('<?php function f(int $n) { |$n; }'), 'int');
    assert.equal(await typeAt('<?php function f(int ...$rest) { |$rest; }'), 'list<int>');
  });

  it('foreach : valeur et clé', async () => {
    assert.equal(await typeAt('<?php foreach ([1, 2] as $k => $v) { |$v; }'), 'element(list<int>)');
    assert.equal(await typeAt('<?php foreach ([1, 2] as $k => $v) { |$k; }'), 'key(list<int>)');
  });

  it('catch, list(), static', async () => {
    assert.equal(await typeAt('<?php try {} catch (A|B $e) { |$e; }'), 'A|B');
    assert.equal(await typeAt("<?php [$a, $b] = [1, 'x']; |$b;"), 'list<int|string>[1]');
    assert.equal(await typeAt("<?php ['k' => $v] = $arr; |$v;"), 'mixed[k]');
    assert.equal(await typeAt('<?php function f() { static $n = 0; |$n; }'), 'int');
  });

  it('@var en ligne', async () => {
    assert.equal(await typeAt('<?php /** @var Foo $x */ |$x;'), 'Foo');
    assert.equal(await typeAt('<?php /** @var Foo */\n$x = make(); |$x;'), 'Foo');
  });

  it('new, $this, new static', async () => {
    assert.equal(await typeAt('<?php namespace App; use Lib\\User; class A { function f() { $u = new User(); |$u; } }'), 'Lib\\User');
    assert.equal(await typeAt('<?php class A { function f() { |$this; } }'), 'static');
    assert.equal(await typeAt('<?php class A { function f() { |new static(); } }'), 'static');
  });

  it('closure use et fonction fléchée : variables du contexte', async () => {
    assert.equal(await typeAt('<?php $a = 1; $f = function () use ($a) { |$a; };'), 'int');
    assert.equal(await typeAt('<?php $a = "x"; $f = fn() => |$a;'), 'string');
  });

  it('global : inconnu ; superglobales : tableau', async () => {
    assert.equal(await typeAt('<?php function f() { global $db; |$db; }'), 'mixed');
    assert.equal(await typeAt('<?php |$_GET;'), 'array<string, mixed>');
  });
});

describe('Inferrer : rétrécissement', () => {
  it('instanceof dans un if', async () => assert.equal(await typeAt('<?php if ($x instanceof Foo) { |$x; }'), 'Foo'));
  it('&& et ternaire', async () => {
    assert.equal(await typeAt('<?php $y = $x instanceof Foo && |$x;'), 'Foo');
    assert.equal(await typeAt('<?php $y = is_string($x) ? |$x : 1;'), 'string');
  });
  it('null écarté', async () => {
    assert.equal(await typeAt('<?php $x = rand() ? null : new Foo(); if ($x !== null) { |$x; }'), 'Foo');
  });
  it('assert', async () => assert.equal(await typeAt('<?php assert($x instanceof Bar); |$x;'), 'Bar'));
});

describe('Inferrer : appels et membres (types différés)', () => {
  it('fonctions et constantes', async () => {
    assert.equal(await typeAt('<?php namespace App; $x = strlen("a"); |$x;'), 'fn(App\\strlen|strlen)');
    assert.equal(await typeAt('<?php |PHP_EOL;'), 'const(PHP_EOL)');
  });

  it('méthodes, propriétés, statiques, constantes de classe', async () => {
    assert.equal(await typeAt('<?php $o = new Foo(); |$o->bar()->baz;'), 'Foo->bar()->baz');
    assert.equal(await typeAt('<?php |Foo::create();'), 'Foo->create()');
    assert.equal(await typeAt('<?php |Foo::VERSION;'), 'Foo::VERSION');
    assert.equal(await typeAt('<?php |Foo::class;'), 'class-string<Foo>');
    assert.equal(await typeAt('<?php $o = new Foo(); |$o?->p;'), 'Foo->p|null');
  });

  it('type de retour déduit d’une fonction', async () => {
    const infer = async (code: string) => {
      const tree = await parse(code);
      const fn = tree.rootNode.namedChildren.find((n) => n.type === 'function_definition')!;
      const type = new Inferrer(extractFile(tree, 'file:///t.php').scopes).inferReturn(fn);
      return type && show(type);
    };
    assert.equal(await infer("<?php function f($c) { if ($c) return 1; return 'x'; }"), 'int|string');
    assert.equal(await infer('<?php function f() { echo 1; }'), 'void');
    assert.equal(await infer('<?php function f() { yield 1; }'), 'Generator');
    assert.equal(await infer('<?php function f($c) { if ($c) return; return 1; }'), 'null|int');
    assert.equal(await infer('<?php function f() { $db = new Db(); return $db; }'), 'Db');
  });
});
