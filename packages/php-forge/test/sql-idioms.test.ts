// Idiomes MySQL / MariaDB courants : aucune alerte sql-* avec le schéma de la base chargé (revue 0.7).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sqlDiagnostics } from '../src/server/sql/diagnostics.ts';
import { Schema } from '../src/server/sql/schema.ts';
import { parse } from './helpers.ts';

function schema(): Schema {
  const s = new Schema();
  const columns = (...names: string[]) => names.map((name) => ({ name, type: 'int', nullable: true }));
  s.addCache({ database: 'crm', refreshed: '', tables: [{ name: 'clients', columns: columns('id', 'nom', 'created') }, { name: 'stats', columns: columns('k', 'v') }] }, 'file:///p/.vscode/php-forge-schema.json');
  return s;
}

async function check(sql: string): Promise<string[]> {
  const code = `<?php\n$q = mysqli_query($db, "${sql}");\n`;
  return sqlDiagnostics(await parse(code), code, schema()).map((d) => `${d.code}: ${d.message}`);
}

describe('idiomes MySQL sans fausse alerte', () => {
  for (const sql of [
    'INSERT INTO stats (k, v) VALUES (1, 2) ON DUPLICATE KEY UPDATE v = VALUES(v)',
    'SELECT id FROM clients WHERE created > NOW() - INTERVAL 7 DAY',
    'SELECT DATE_ADD(created, INTERVAL 1 MONTH) AS d FROM clients',
    'SELECT EXTRACT(YEAR FROM created) AS y FROM clients',
    "SELECT TRIM(LEADING '0' FROM nom) AS n FROM clients",
    'SELECT @rank := @rank + 1 AS r, nom FROM clients',
    'SELECT nom INTO @x FROM clients WHERE id = 1',
    'WITH r AS (SELECT id FROM clients) SELECT id FROM r',
    "SELECT id FROM clients WHERE MATCH(nom) AGAINST('x' IN BOOLEAN MODE)",
    'SELECT nom FROM clients ORDER BY nom COLLATE utf8_bin',
    'SELECT id FROM clients WHERE id = 0x1F',
    "SELECT id FROM clients WHERE nom = b'0101'",
  ]) {
    it(sql, async () => assert.deepEqual(await check(sql), []));
  }

  it('les vraies erreurs restent signalées', async () => {
    assert.deepEqual(await check('SELECT prenom FROM clients WHERE created > NOW() - INTERVAL 1 DAY'), ['sql-unknown-column: Unknown column prenom in clients']);
    assert.deepEqual(await check('INSERT INTO stats (k, w) VALUES (1, 2) ON DUPLICATE KEY UPDATE w = 3'), ['sql-unknown-column: Unknown column w in stats', 'sql-unknown-column: Unknown column w in stats']);
    assert.deepEqual(await check('SELECT id FROM inconnue'), ['sql-unknown-table: Unknown table inconnue']);
  });
});

describe('requête entière : seulement un argument direct ou une variable jamais complétée', () => {
  const syntax = async (code: string) => sqlDiagnostics(await parse(`<?php\n${code}\n`), `<?php\n${code}\n`, undefined).map((d) => d.message);

  for (const code of [
    `$this->sql = "SELECT * FROM t WHERE (a = 1"; $this->sql .= " OR b = 2)";`,
    `$q['list'] = "SELECT * FROM t WHERE (a = 1"; $q['list'] .= ")";`,
    `$sql = "SELECT * FROM t WHERE (a = 1"; $sql2 = "$sql OR b = 2)";`,
    `$sql = "SELECT * FROM t WHERE id IN ("; $sql2 = <<<SQL\n{$sql} 1, 2)\nSQL;\n`,
    `function w() { return "SELECT * FROM t WHERE (a = 1"; }`,
  ]) {
    it(code, async () => assert.deepEqual(await syntax(code), []));
  }

  it('argument direct et variable entière : parenthèse non fermée signalée', async () => {
    assert.deepEqual(await syntax(`mysqli_query($db, "SELECT * FROM t WHERE (a = 1");`), ['SQL syntax: ( is never closed']);
    assert.deepEqual(await syntax(`$sql = "SELECT * FROM t WHERE (a = 1"; mysqli_query($db, $sql);`), ['SQL syntax: ( is never closed']);
  });
});
