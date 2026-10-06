import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractFile } from '../src/server/model/extract.ts';
import { extract, parse } from './helpers.ts';

describe('résumés : programmes et chemins des includes', () => {
  it('includes avec chemin symbolique et programme du fichier', async () => {
    const file = await extract("<?php\ninclude __DIR__ . '/a.php';\n$x = new PDO('x');\nfunction f($p) { return $p; }\n");
    assert.deepEqual(file.includes.map((i) => [i.kind, i.expression, i.path]), [
      ['include', "__DIR__ . '/a.php'", { k: 'cat', parts: [{ k: 'dir' }, { k: 'lit', v: '/a.php' }] }],
    ]);
    assert.deepEqual(file.flow?.main.map((o) => o.op), ['include', 'use', 'assign']);
    assert.deepEqual(file.flow?.main.find((o) => o.op === 'assign'), { op: 'assign', name: 'x', at: [2, 0], type: { kind: 'class', fqn: 'PDO' } });
    assert.deepEqual(file.flow?.functions.map((f) => f.name), ['f']);
  });

  it('sans inférence (frappe) : programme sans types', async () => {
    const file = extractFile(await parse("<?php\n$x = new PDO('x');\n"), 'file:///t.php', { infer: false });
    assert.equal((file.flow?.main.find((o) => o.op === 'assign') as { type?: unknown }).type, undefined);
  });

  it('résumé sérialisable (cache, workers)', async () => {
    const file = await extract("<?php\nif ($a) { include 'x.php'; } else { $b = 1; }\n");
    assert.deepEqual(JSON.parse(JSON.stringify(file)), file);
  });
});
