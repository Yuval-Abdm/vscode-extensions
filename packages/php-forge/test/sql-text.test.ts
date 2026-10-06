import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findQueries } from '../src/server/sql/tokens.ts';
import { sqlOffset, sqlText } from '../src/server/sql/text.ts';
import { parse } from './helpers.ts';

async function queries(code: string) {
  return findQueries(await parse(code)).map((q) => ({ complete: q.complete, ...sqlText(q) }));
}

describe('texte SQL des requêtes', () => {
  it('concaténation et interpolation remplacées par des trous ; requête entière ou non', async () => {
    const code = "<?php\n$a = \"SELECT * FROM t WHERE id = $id\";\n$b = 'SELECT nom FROM u WHERE x = '.$x.' LIMIT 1';\n$c = 'SELECT 1 FROM v';\n$c .= ' WHERE y = 2';\nmysqli_query($db, 'DELETE FROM w');\n$d = 'INSERT INTO z (a';\n$e = $d . ', b)';\n";
    const list = await queries(code);
    assert.deepEqual(list.map((q) => [q.text, q.complete]), [
      ['SELECT * FROM t WHERE id = ?0?', true],
      ['SELECT nom FROM u WHERE x = ?0? LIMIT 1', false],
      ['SELECT 1 FROM v', false],
      [' WHERE y = 2', false],
      ['DELETE FROM w', true],
      ['INSERT INTO z (a', false],
    ]);
  });

  it('positions : chaque caractère situé dans le document, échappements compris', async () => {
    const code = "<?php\n$q = \"SELECT 'a\\\"b' FROM t\";\n";
    const [q] = await queries(code);
    assert.equal(q.text, `SELECT 'a"b' FROM t`);
    const from = q.text.indexOf('FROM');
    assert.equal(code.slice(q.source[from], q.source[from] + 4), 'FROM');
    assert.equal(sqlOffset(q, q.source[from]), from);
    assert.equal(sqlOffset(q, code.indexOf('";')), q.text.length);
  });
});

describe('indice /** @sql */', () => {
  it('chaîne qui ne ressemble pas à du SQL : requête si un commentaire @sql la précède', async () => {
    const tree = await parse(`<?php\n/** @sql */\n$where = 'id_client = ' . $id . ' AND actif = 1';\n$texte = 'id = ' . $id;\n$w2 = 'x = 1'; // @sql\n`);
    assert.deepEqual(findQueries(tree).map((q) => q.root.text), [`'id_client = ' . $id . ' AND actif = 1'`, `'x = 1'`]);
  });
});
