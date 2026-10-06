import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COLUMNS_QUERY, connectionKey, fetchSchema, isAccessDenied, missingFields, schemaCache, type Driver } from '../src/client/sqlSchema.ts';

const rows = [
  { TABLE_NAME: 'clients', COLUMN_NAME: 'id', COLUMN_TYPE: 'int(11)', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null },
  { TABLE_NAME: 'clients', COLUMN_NAME: 'nom', COLUMN_TYPE: 'varchar(100)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: "'x'" },
  { TABLE_NAME: 'contrats', COLUMN_NAME: 'montant', COLUMN_TYPE: 'decimal(10,2)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: 'NULL' },
];

describe('Refresh SQL schema', () => {
  it('lignes de INFORMATION_SCHEMA.COLUMNS → cache (tables dans l’ordre, NULL de MariaDB = pas de défaut)', () => {
    assert.deepEqual(schemaCache('crm', rows, '2026-10-05T10:00:00.000Z'), {
      database: 'crm',
      refreshed: '2026-10-05T10:00:00.000Z',
      tables: [
        { name: 'clients', columns: [{ name: 'id', type: 'int(11)', nullable: false }, { name: 'nom', type: 'varchar(100)', nullable: true, default: "'x'" }] },
        { name: 'contrats', columns: [{ name: 'montant', type: 'decimal(10,2)', nullable: true }] },
      ],
    });
  });

  it('lecture seule, une requête paramétrée, connexion toujours fermée', async () => {
    const calls: string[] = [];
    let ended = 0;
    const driver = (fail: boolean): Driver => ({
      query: async (sql, params) => {
        calls.push(`${sql} ${JSON.stringify(params)}`);
        if (fail && sql === COLUMNS_QUERY) throw Object.assign(new Error('boom'), { code: 'ER_X' });
        return sql === COLUMNS_QUERY ? rows : [];
      },
      end: async () => {
        ended++;
      },
    });
    const cache = await fetchSchema(async () => driver(false), 'crm', new Date('2026-10-05T10:00:00Z'));
    assert.equal(cache.tables.length, 2);
    assert.deepEqual(calls, ['SET SESSION TRANSACTION READ ONLY []', `${COLUMNS_QUERY} ["crm"]`]);
    await assert.rejects(fetchSchema(async () => driver(true), 'crm', new Date()), /boom/);
    assert.equal(ended, 2);
  });

  it('MySQL 5.5 / MariaDB 5.5 (pas de READ ONLY) : la lecture continue', async () => {
    const driver: Driver = {
      query: async (sql) => {
        if (sql.startsWith('SET SESSION')) throw Object.assign(new Error('You have an error in your SQL syntax'), { code: 'ER_PARSE_ERROR' });
        return rows;
      },
      end: async () => {},
    };
    assert.equal((await fetchSchema(async () => driver, 'crm', new Date())).tables.length, 2);
  });

  it('réglages manquants, clé du secret, refus d’accès', () => {
    assert.deepEqual(missingFields({ host: 'db', user: '' }), ['user', 'database']);
    assert.deepEqual(missingFields({ host: 'db', user: 'u', database: 'crm' }), []);
    assert.equal(connectionKey({ host: 'db', port: 3306, user: 'u', database: 'crm' }), 'phpForge.sql.password:u@db:3306');
    assert.equal(isAccessDenied(Object.assign(new Error('x'), { code: 'ER_ACCESS_DENIED_ERROR' })), true);
    assert.equal(isAccessDenied(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), false);
  });
});
