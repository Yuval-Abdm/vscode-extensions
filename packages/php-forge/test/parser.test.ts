import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from './helpers.ts';

test('analyse un fichier mêlant HTML et PHP', async () => {
  const tree = await parse('<p><?php echo 1; ?></p>');
  assert.equal(tree.rootNode.type, 'program');
  assert.equal(tree.rootNode.hasError, false);
});

test('marque les erreurs de syntaxe sans échouer', async () => {
  const tree = await parse('<?php function (');
  assert.equal(tree.rootNode.hasError, true);
});

test('positions en unités UTF-16, comme LSP', async () => {
  const code = "<?php $é = '😀'; function f() {}";
  const fn = (await parse(code)).rootNode.namedChildren.find((n) => n.type === 'function_definition')!;
  assert.deepEqual(fn.startPosition, { row: 0, column: code.indexOf('function') });
  assert.equal(fn.startIndex, code.indexOf('function'));
});
