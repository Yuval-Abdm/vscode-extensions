import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sqlDiagnostics } from '../src/server/sql/diagnostics.ts';
import { sqlAt, sqlCompletion, sqlHover, sqlTarget } from '../src/server/sql/features.ts';
import { parseSqlFile, Schema } from '../src/server/sql/schema.ts';
import { cursor, parse } from './helpers.ts';

const SCHEMA = 'CREATE TABLE clients (\n  id int(11) NOT NULL,\n  nom varchar(100) DEFAULT NULL,\n  solde decimal(10,2) NOT NULL DEFAULT 0\n);\nCREATE TABLE contrats (id int, client_id int, montant decimal(10,2));\n';

function schema(fromDatabase = false): Schema {
  const s = new Schema();
  s.add(parseSqlFile(SCHEMA, 'file:///p/sql/schema.sql'));
  if (fromDatabase) s.addCache({ database: 'crm', refreshed: '', tables: [] }, 'file:///p/.vscode/php-forge-schema.json');
  return s;
}

async function site(code: string) {
  const { text, position } = cursor(code);
  const lines = text.split('\n');
  const index = lines.slice(0, position.line).reduce((n, l) => n + l.length + 1, 0) + position.character;
  return { text, at: sqlAt(await parse(text), index)!, index };
}

describe('SQL : complétion, survol, définition', () => {
  it('tables après FROM, colonnes d’un alias, colonnes et fonctions dans WHERE', async () => {
    const tables = sqlCompletion((await site('<?php\n$q = "SELECT * FROM cl|";\n')).at, schema())!;
    assert.deepEqual(tables.items.map((i) => i.label), ['clients', 'contrats']);
    assert.equal(tables.items[0].detail, '3 columns');
    const { text, at, index } = await site('<?php\n$q = "SELECT c.| FROM clients c";\n');
    const columns = sqlCompletion(at, schema())!;
    assert.deepEqual(columns.items.map((i) => i.label), ['id', 'nom', 'solde']);
    assert.equal(columns.from, index);
    assert.equal(text[columns.from - 1], '.');
    const where = sqlCompletion((await site('<?php\nmysqli_query($db, "SELECT * FROM contrats k WHERE mo|");\n')).at, schema())!;
    assert.ok(where.items.some((i) => i.label === 'montant' && i.kind === 'column'));
    assert.ok(where.items.some((i) => i.label === 'COUNT' && i.kind === 'function'));
  });

  it('survol d’une colonne et d’une table ; définition dans le fichier .sql', async () => {
    const column = sqlTarget((await site('<?php\n$q = "SELECT c.so|lde FROM clients c";\n')).at, schema())!;
    assert.equal(sqlHover(column), '`clients.solde` — `decimal(10,2)` · NOT NULL · DEFAULT 0');
    const table = sqlTarget((await site('<?php\n$q = "SELECT * FROM cli|ents";\n')).at, schema())!;
    assert.match(sqlHover(table), /^\*\*clients\*\* \(3 columns\)/);
    assert.deepEqual([table.table.uri, table.table.line, table.table.character], ['file:///p/sql/schema.sql', 0, 13]);
  });
});

describe('SQL : diagnostics', () => {
  const diag = async (code: string, s?: Schema) => sqlDiagnostics(await parse(code), code, s).map((d) => `${d.range.start.line}:${d.range.start.character} ${d.code} ${d.message}`);

  it('syntaxe sûre : virgule avant FROM, WHERE AND, parenthèse et guillemet non fermés (requête entière)', async () => {
    assert.deepEqual(await diag("<?php\n$a = mysqli_query($db, 'SELECT id, FROM t');\n$b = 'SELECT * FROM t WHERE AND x = 1';\n$c = mysqli_query($db, 'SELECT * FROM t WHERE id IN (1, 2');\n"), [
      '1:33 sql-syntax SQL syntax: comma before FROM',
      '2:28 sql-syntax SQL syntax: AND right after WHERE',
      '3:52 sql-syntax SQL syntax: ( is never closed',
    ]);
    // Requête en morceaux : pas de vérification d'équilibre
    assert.deepEqual(await diag("<?php\n$s = 'SELECT * FROM t WHERE id IN (';\n$s .= implode(',', $ids) . ')';\n"), []);
  });

  it('colonnes inconnues (tables entièrement connues) ; tables inconnues seulement avec le schéma de la base', async () => {
    assert.deepEqual(await diag('<?php\n$q = "SELECT c.nom, c.age FROM clients c WHERE inconnu = 1";\n', schema()), [
      '1:22 sql-unknown-column Unknown column age in clients',
      '1:47 sql-unknown-column Unknown column inconnu in clients',
    ]);
    assert.deepEqual(await diag('<?php\n$q = "SELECT * FROM ailleurs";\n', schema()), []);
    assert.deepEqual(await diag('<?php\n$q = "SELECT * FROM ailleurs";\n', schema(true)), ['1:20 sql-unknown-table Unknown table ailleurs']);
    assert.deepEqual(await diag('<?php\n$q = "SELECT x FROM clients WHERE id = $id AND " . $cond;\n', schema()), []);
  });
});
