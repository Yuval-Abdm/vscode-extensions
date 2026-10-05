import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FlowOp } from '../src/shared/types.ts';
import { extractFlow } from '../src/server/includes/program.ts';
import { newScope } from '../src/server/model/names.ts';
import { rangeOf } from '../src/server/model/ranges.ts';
import { Inferrer } from '../src/server/types/infer.ts';
import { parse } from './helpers.ts';

/** Forme lisible d'un programme : « a:x » affectation, « g:x » garde, « r:x » lecture, « [..|..]! » branches exhaustives… */
function render(ops: FlowOp[]): string {
  return ops.map((o): string => {
    switch (o.op) {
      case 'assign': return `${o.guard ? 'g' : 'a'}:${o.name}`;
      case 'read': return `r:${o.name}`;
      case 'include': return `i:${o.index}`;
      case 'unset': return `u:${o.name}`;
      case 'extract': return `x:${o.source}`;
      case 'dynamic': return 'dyn';
      case 'exit': return o.ret ? 'ret' : 'exit';
      case 'define': return `def:${o.name}`;
      case 'call': return `call:${o.method ? `->${o.method}` : o.names[0] ?? '?'}(${o.args.map((a) => `${a.index}=${a.name}`).join(',')})`;
      case 'use': return `use:${o.kind}:${o.names[0]}`;
      case 'autoload': return 'autoload';
      case 'branch': return `[${o.alts.map(render).join(' | ')}]${o.exhaustive ? '!' : ''}`;
      case 'loop': return `loop{${render(o.body)}}`;
    }
  }).join(' ');
}

async function flowOf(code: string, typed = false) {
  const tree = await parse(`<?php\n${code}\n`);
  const scopes = [newScope('', rangeOf(tree.rootNode))];
  return extractFlow(tree.rootNode, scopes, typed ? new Inferrer(scopes) : undefined);
}

const main = async (code: string) => render((await flowOf(code)).flow.main);

describe('programme des variables', () => {
  it('affectations et lectures dans l’ordre (la valeur avant la cible)', async () => {
    assert.equal(await main('$a = 1; echo $a; echo $b; $c = $c + 1;'), 'a:a r:a r:b r:c a:c');
  });

  it('superglobales, $this et variables de PHP jamais lues', async () => {
    assert.equal(await main('echo $_POST["a"], $GLOBALS["x"], $argv[0], $this;'), '');
  });

  it('if / elseif / else', async () => {
    assert.equal(await main('if ($c) { $x = 1; } else { $x = 2; } echo $x;'), 'r:c [a:x | a:x]! r:x');
    assert.equal(await main('if ($c) { $x = 1; } elseif ($d) { $x = 2; }'), 'r:c [a:x | r:d a:x]');
  });

  it('gardes isset / empty et leurs négations', async () => {
    assert.equal(await main('if (isset($x)) { echo $x; }'), '[g:x r:x]');
    assert.equal(await main('if (!isset($x)) { $x = 1; } echo $x;'), '[a:x | g:x]! r:x');
    assert.equal(await main('if (!isset($x)) return; echo $x;'), '[ret | g:x]! r:x');
    assert.equal(await main('$y = isset($x) ? $x : 0;'), '[g:x r:x | ]! a:y');
    assert.equal(await main('if (!empty($x) && $x > 1) {}'), '[g:x r:x] [g:x]');
    assert.equal(await main('if (!isset($x) || $x == "") { $x = 2; }'), '[g:x r:x] [a:x | g:x]!');
    assert.equal(await main('if (isset($t["k"])) { echo $t["k"]; }'), '[g:t r:t]');
  });

  it('??, ??=, @, isset, empty, compact : pas de lecture', async () => {
    assert.equal(await main('$z = $a ?? "d"; $w ??= 1; echo @$u, isset($b), empty($c); compact("d");'), 'a:z a:w');
    assert.equal(await main('$z = $a ?? $b;'), '[r:b] a:z');
  });

  it('&& et || : la partie droite est conditionnelle', async () => {
    assert.equal(await main('$ok = $a && ($b = 1);'), 'r:a [a:b] a:ok');
  });

  it('switch avec cas enchaînés et default', async () => {
    assert.equal(await main('switch ($a) { case 1: case 2: $x = 1; break; default: $x = 2; }'), 'r:a [a:x | a:x | a:x]!');
    assert.equal(await main('switch ($a) { case 1: $x = 1; break; }'), 'r:a [a:x]');
  });

  it('boucles : foreach, while, for, do', async () => {
    assert.equal(await main('foreach ($t as $k => $v) { echo $v; } while ($c) { $i = 1; }'), 'r:t loop{a:k a:v r:v} r:c loop{a:i}');
    assert.equal(await main('for ($i = 0; $i < $n; $i++) { echo $i; }'), 'a:i r:i r:n loop{r:i r:i a:i}');
    assert.equal(await main('do { $x = 1; } while ($x);'), 'a:x r:x');
    assert.equal(await main('foreach ($t as [$a, $b]) {}'), 'r:t loop{a:a a:b}');
  });

  it('for sans accolades ou en syntaxe alternative (endfor) : pas de boucle infinie', async () => {
    assert.equal(await main('for ($i = 0; $i < 3; $i++): echo $i; endfor;'), 'a:i r:i loop{r:i r:i a:i}');
    assert.equal(await main('for ($i = 0; $i < 3; $i++) echo $i;'), 'a:i r:i loop{r:i r:i a:i}');
    assert.equal(await main('for ($i = 0; $i < $n; $i++): ?><i></i><?php endfor ?>'), 'a:i r:i r:n loop{r:i a:i}');
  });

  it('try / catch / finally', async () => {
    assert.equal(await main('try { $a = 1; } catch (Exception $e) { $a = 0; } finally { echo $a; }'), '[a:a | a:e a:a]! r:a');
  });

  it('appels : variables nues pour les paramètres par référence', async () => {
    assert.equal(await main('preg_match($re, $s, $m);'), 'use:function:preg_match call:preg_match(0=re,1=s,2=m)');
    assert.equal(await main('$db->bind_result($x);'), 'r:db call:->bind_result(0=x)');
    assert.equal(await main('f($a + 1, g($b));'), 'use:function:f r:a use:function:g call:g(0=b)');
    assert.equal(await main('parse_str($q, $out);'), 'r:q a:out');
  });

  it('extract, dynamique, eval', async () => {
    assert.equal(await main('extract($_POST); extract(["a" => 1, "b" => 2]); extract($row);'), 'x:request a:a a:b r:row x:other');
    assert.equal(await main('$$n = 1; eval($code); parse_str($q);'), 'r:n dyn r:code dyn r:q dyn');
  });

  it('global, static, list, unset, return dans une fonction', async () => {
    const { flow } = await flowOf('function f() { global $db; static $n = 0; list($a, $b) = g(); unset($a); return $db; }');
    assert.equal(render(flow.main), '');
    assert.deepEqual(flow.functions.map((f) => [f.name, f.params, render(f.body)]), [['f', [], 'a:db a:n use:function:g a:a a:b u:a r:db ret']]);
  });

  it('closures et fonctions fléchées', async () => {
    const { flow } = await flowOf('$f = function ($p) use ($q, &$r) { return $p . $q . $r; }; $g = fn($x) => $x + $y;');
    assert.equal(render(flow.main), 'r:q a:r a:f [a:x r:x r:y] a:g');
    assert.deepEqual(flow.functions.map((f) => [f.name, f.params, render(f.body)]), [['closure', ['p', 'q', 'r', 'this'], 'r:p r:q r:r ret']]);
  });

  it('classes : parents utilisés, méthodes avec $this', async () => {
    const { flow } = await flowOf('class A extends B { function m($x) { return $this->y + $x; } public static function s() {} }');
    assert.equal(render(flow.main), 'use:class:B');
    assert.deepEqual(flow.functions.map((f) => [f.name, f.params, render(f.body)]), [['A::m', ['x', 'this'], 'r:x ret'], ['A::s', [], '']]);
    assert.deepEqual(flow.functions[0].lines, [1, 1]);
  });

  it('includes, define et const', async () => {
    const { flow, includes } = await flowOf("define('ROOT', __DIR__); const APP = 'x'; include ROOT . '/a.php'; require_once 'b.php';");
    assert.equal(render(flow.main), 'def:ROOT def:APP use:constant:ROOT i:0 i:1');
    assert.deepEqual(includes.map((i) => [i.kind, i.expression, i.path]), [
      ['include', "ROOT . '/a.php'", { k: 'cat', parts: [{ k: 'const', name: 'ROOT' }, { k: 'lit', v: '/a.php' }] }],
      ['require_once', "'b.php'", { k: 'lit', v: 'b.php' }],
    ]);
    assert.deepEqual(includes[0].range.start, { line: 1, character: 42 });
  });

  it('indice @include et variable locale du chemin', async () => {
    const { includes } = await flowOf("$base = __DIR__ . '/inc';\ninclude $base . '/a.php';\n/** @include lib/x.php */\ninclude $dyn;");
    assert.deepEqual(includes[0].path, { k: 'cat', parts: [{ k: 'dir' }, { k: 'lit', v: '/inc/a.php' }] });
    assert.deepEqual([includes[1].path, includes[1].hint], [{ k: 'lit', v: 'lib/x.php' }, true]);
  });

  it('symboles utilisés : new, appels statiques, constantes de classe, constantes', async () => {
    assert.equal(await main('new Foo($a); Bar::baz(); echo Qux::C, FOO, true; spl_autoload_register("f");'), 'use:class:Foo r:a use:class:Bar use:class:Qux use:constant:FOO autoload');
    assert.equal(await main('self::x(); static::$y; new static();'), '');
  });

  it('un seul « use » par symbole et par portée (première utilisation)', async () => {
    const { flow } = await flowOf('helper(); helper(); new A(); new A(); function f() { helper(); helper(); }');
    assert.equal(render(flow.main), 'use:function:helper use:class:A');
    assert.equal(render(flow.functions[0].body), 'use:function:helper');
  });

  it('@var en tête de fichier : variable externe typée', async () => {
    const { flow } = await flowOf('/** @var PDO $pdo */\n$pdo->query("x");');
    assert.equal(render(flow.main), 'a:pdo r:pdo');
    assert.deepEqual((flow.main[0] as { type?: unknown }).type, { kind: 'class', fqn: 'PDO' });
  });

  it('types des affectations du niveau fichier avec un Inferrer', async () => {
    const { flow } = await flowOf('$pdo = new PDO("x"); function f() { $loc = new PDO("y"); }', true);
    assert.deepEqual((flow.main.find((o) => o.op === 'assign') as { type?: unknown }).type, { kind: 'class', fqn: 'PDO' });
    assert.equal((flow.functions[0].body.find((o) => o.op === 'assign') as { type?: unknown }).type, undefined);
  });

  it('positions des lectures', async () => {
    const op = (await flowOf('echo $abc;')).flow.main[0];
    assert.deepEqual(op, { op: 'read', name: 'abc', at: [1, 5], end: 9 });
  });

  it('exit, die, throw', async () => {
    assert.equal(await main('if ($a) { exit; } if ($b) { die("x"); } if ($c) { throw new E(); }'), 'r:a [exit] r:b [exit] r:c [use:class:E exit]');
  });
});
