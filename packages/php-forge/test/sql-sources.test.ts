import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { sqlDiagnostics } from '../src/server/sql/diagnostics.ts';
import { isSchemaSource, loadSchema, SCHEMA_CACHE } from '../src/server/sql/sources.ts';
import { parse } from './helpers.ts';

const root = mkdtempSync(path.join(tmpdir(), 'php-forge-sql-'));
const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};
const sources = (extra: Partial<Parameters<typeof loadSchema>[0]> = {}) => ({ folders: [root], globs: ['sql/**/*.sql', 'migrations/**/*.sql'], exclude: ['**/node_modules/**'], ...extra });

write('migrations/001_ajout.sql', 'ALTER TABLE clients ADD COLUMN email varchar(255) DEFAULT NULL;\nALTER TABLE factures ADD total decimal(10,2);\n');
write('sql/schema.sql', 'CREATE TABLE clients (\n  id int(11) NOT NULL,\n  nom varchar(100) DEFAULT NULL\n);\n');
write('sql/node_modules/x.sql', 'CREATE TABLE ignoree (id int);\n');
write('autre/hors-glob.sql', 'CREATE TABLE hors (id int);\n');

describe('schéma SQL du workspace', () => {
  after(() => rmSync(root, { recursive: true, force: true }));

  it('fichiers .sql des globs : CREATE TABLE complet, ALTER TABLE ajouté, exclusions respectées', () => {
    const { schema, files, errors } = loadSchema(sources());
    assert.deepEqual(errors, []);
    assert.equal(files, 2);
    assert.deepEqual(schema.tables.map((t) => t.name).sort(), ['clients', 'factures']);
    const clients = schema.table('clients')!;
    assert.equal(clients.complete, true);
    assert.deepEqual(clients.columns.map((c) => c.name).sort(), ['email', 'id', 'nom']);
    // Définition : le CREATE TABLE, même si le ALTER TABLE a été lu avant
    assert.ok(clients.uri!.endsWith('/sql/schema.sql'), clients.uri);
    assert.equal(schema.table('factures')!.complete, false);
    assert.equal(schema.fromDatabase, false);
  });

  it('cache de la base : tables complètes, table inconnue signalée', async () => {
    write(SCHEMA_CACHE, JSON.stringify({ database: 'crm', refreshed: '2026-10-05T00:00:00Z', tables: [{ name: 'contrats', columns: [{ name: 'id', type: 'int', nullable: false }] }] }));
    try {
      const { schema } = loadSchema(sources());
      assert.equal(schema.fromDatabase, true);
      assert.ok(schema.table('contrats')?.complete);
      const code = '<?php\n$q = "SELECT * FROM inconnue";\n';
      assert.deepEqual(sqlDiagnostics(await parse(code), code, schema).map((d) => d.code), ['sql-unknown-table']);
    } finally {
      rmSync(path.join(root, SCHEMA_CACHE));
    }
  });

  it('cache corrompu : ignoré avec une erreur, les fichiers .sql restent', () => {
    write(SCHEMA_CACHE, '{ pas du json');
    try {
      const { schema, errors } = loadSchema(sources());
      assert.equal(errors.length, 1);
      assert.match(errors[0], /php-forge-schema\.json/);
      assert.ok(schema.table('clients'));
      assert.equal(schema.fromDatabase, false);
    } finally {
      rmSync(path.join(root, SCHEMA_CACHE));
    }
  });

  it('fichier trop gros (dump de données) : ignoré, signalé', () => {
    const { schema, errors } = loadSchema(sources({ maxSize: 100 }));
    assert.ok(errors.some((e) => e.includes('migrations/001_ajout.sql')), errors.join());
    assert.ok(schema.table('clients'));
  });

  it('fichiers qui alimentent le schéma', () => {
    assert.equal(isSchemaSource(path.join(root, 'sql/a.sql'), sources()), true);
    assert.equal(isSchemaSource(path.join(root, 'autre/b.sql'), sources()), false);
    assert.equal(isSchemaSource(path.join(root, SCHEMA_CACHE), sources()), true);
    assert.equal(isSchemaSource(path.join(root, 'sql/a.php'), sources()), false);
    assert.equal(isSchemaSource('/ailleurs/sql/a.sql', sources()), false);
  });
});
