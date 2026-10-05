import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { includeHint, pathExprOf } from '../src/server/includes/pathExpr.ts';
import type { Node } from '../src/server/parser/parser.ts';
import { parse } from './helpers.ts';

const INCLUDES = ['include_expression', 'include_once_expression', 'require_expression', 'require_once_expression'];

async function includeOf(code: string): Promise<Node> {
  const tree = await parse(`<?php\n${code}\n`);
  return tree.rootNode.descendantsOfType(INCLUDES)[0];
}

async function pathOf(code: string) {
  const include = await includeOf(code);
  let path = include.namedChildren[0];
  if (path.type === 'parenthesized_expression') path = path.namedChildren[0];
  return pathExprOf(path);
}

describe('chemins d’include symboliques', () => {
  it('littéraux simples et doubles', async () => {
    assert.deepEqual(await pathOf("include 'a/b.php';"), { k: 'lit', v: 'a/b.php' });
    assert.deepEqual(await pathOf('include "a/b.php";'), { k: 'lit', v: 'a/b.php' });
    assert.deepEqual(await pathOf("include 'it\\'s.php';"), { k: 'lit', v: "it's.php" });
  });

  it('__DIR__, __FILE__, dirname avec niveaux', async () => {
    assert.deepEqual(await pathOf("include __DIR__ . '/a.php';"), { k: 'cat', parts: [{ k: 'dir' }, { k: 'lit', v: '/a.php' }] });
    assert.deepEqual(await pathOf("require_once(dirname(__FILE__, 2) . '/b.php');"), {
      k: 'cat', parts: [{ k: 'dirname', of: { k: 'file' }, levels: 2 }, { k: 'lit', v: '/b.php' }],
    });
    assert.deepEqual(await pathOf("include dirname(dirname(__FILE__)) . '/c.php';"), {
      k: 'cat', parts: [{ k: 'dirname', of: { k: 'dirname', of: { k: 'file' }, levels: 1 }, levels: 1 }, { k: 'lit', v: '/c.php' }],
    });
  });

  it('DOCUMENT_ROOT, constantes, realpath', async () => {
    assert.deepEqual(await pathOf("include $_SERVER['DOCUMENT_ROOT'].'/c.php';"), { k: 'cat', parts: [{ k: 'docroot' }, { k: 'lit', v: '/c.php' }] });
    assert.deepEqual(await pathOf('include $_SERVER["DOCUMENT_ROOT"]."/c.php";'), { k: 'cat', parts: [{ k: 'docroot' }, { k: 'lit', v: '/c.php' }] });
    assert.deepEqual(await pathOf("include ROOT_PATH.'/d.php';"), { k: 'cat', parts: [{ k: 'const', name: 'ROOT_PATH' }, { k: 'lit', v: '/d.php' }] });
    assert.deepEqual(await pathOf("include realpath(__DIR__.'/../e.php');"), { k: 'cat', parts: [{ k: 'dir' }, { k: 'lit', v: '/../e.php' }] });
  });

  it('partie inconnue gardée dans la concaténation (préfixe)', async () => {
    assert.deepEqual(await pathOf("include ROOT_PATH.'/templates/'.$page.'.php';"), {
      k: 'cat', parts: [{ k: 'const', name: 'ROOT_PATH' }, { k: 'lit', v: '/templates/' }, { k: 'unknown' }, { k: 'lit', v: '.php' }],
    });
    assert.deepEqual(await pathOf('include "a/$x.php";'), { k: 'cat', parts: [{ k: 'lit', v: 'a/' }, { k: 'unknown' }, { k: 'lit', v: '.php' }] });
    assert.deepEqual(await pathOf("include foo();"), { k: 'unknown' });
  });

  it('variable locale affectée une seule fois', async () => {
    const tree = await parse("<?php\n$f = __DIR__ . '/x.php';\ninclude $f;\n");
    const value = tree.rootNode.descendantsOfType('assignment_expression')[0].childForFieldName('right')!;
    const include = tree.rootNode.descendantsOfType('include_expression')[0];
    const local = (name: string, before: number) => (name === 'f' && value.startIndex < before ? value : undefined);
    assert.deepEqual(pathExprOf(include.namedChildren[0], local), { k: 'cat', parts: [{ k: 'dir' }, { k: 'lit', v: '/x.php' }] });
  });

  it('indice @include sur la ligne précédente', async () => {
    assert.equal(includeHint(await includeOf('/** @include lib/x.php */\ninclude $dyn;')), 'lib/x.php');
    assert.equal(includeHint(await includeOf("// @include 'lib/y.php'\ninclude $dyn;")), 'lib/y.php');
    assert.equal(includeHint(await includeOf('/** @include lib/x.php */\n\n\ninclude $dyn;')), undefined);
    assert.equal(includeHint(await includeOf('include $dyn;')), undefined);
  });
});
