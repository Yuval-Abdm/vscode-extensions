import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeSql, contextAt } from '../src/server/sql/analyze.ts';

const cols = (sql: string) => analyzeSql(sql).columns.map((c) => (c.qualifier ? `${c.qualifier}.${c.name}` : c.name));

describe('analyse SQL tolérante', () => {
  it('tables et alias : FROM, JOIN, liste, UPDATE, INSERT INTO, base.table, backquotes', () => {
    const a = analyzeSql('SELECT * FROM clients c INNER JOIN `contrats` AS k ON k.client_id = c.id');
    assert.deepEqual(a.tables.map((t) => [t.name, t.alias]), [['clients', 'c'], ['contrats', 'k']]);
    assert.deepEqual(analyzeSql('SELECT * FROM crm.agences ag, villes').tables.map((t) => [t.name, t.alias]), [['agences', 'ag'], ['villes', undefined]]);
    assert.deepEqual(analyzeSql('UPDATE clients SET nom = 1').tables.map((t) => t.name), ['clients']);
    assert.deepEqual(analyzeSql('INSERT INTO logs (a, b) VALUES (1, 2)').tables.map((t) => t.name), ['logs']);
    assert.deepEqual(analyzeSql('DELETE FROM sessions WHERE id = 3').tables.map((t) => t.name), ['sessions']);
  });

  it('colonnes : qualifiées, nues dans les clauses ; pas les fonctions, alias, valeurs, mots-clés', () => {
    assert.deepEqual(cols('SELECT c.nom, prenom, COUNT(*) AS total FROM clients c WHERE actif = 1 ORDER BY total DESC'), ['c.nom', 'prenom', 'actif']);
    assert.deepEqual(cols("UPDATE clients SET nom = 'x', solde = solde + 1 WHERE id = ?0?"), ['nom', 'solde', 'solde', 'id']);
    assert.deepEqual(cols('INSERT INTO logs (a, b) VALUES (now, 2)'), ['a', 'b']);
    assert.deepEqual(cols('SELECT DATE_FORMAT(d, "%Y") annee, x FROM t'), ['d', 'x']);
  });

  it('colonnes du SELECT : clés du résultat', () => {
    assert.deepEqual(analyzeSql('SELECT id, c.nom, prenom AS p, COUNT(*) total, NOW() FROM clients c').select, [
      { key: 'id', column: { name: 'id' } },
      { key: 'nom', column: { qualifier: 'c', name: 'nom' } },
      { key: 'p', column: { name: 'prenom' } },
      { key: 'total' },
      { key: 'NOW()' },
    ]);
    assert.equal(analyzeSql('SELECT * FROM t').select, undefined);
    assert.equal(analyzeSql('SELECT ?0? FROM t').select, undefined);
  });

  it('contexte au curseur', () => {
    assert.deepEqual(contextAt('SELECT * FROM ', 14), { kind: 'table' });
    assert.deepEqual(contextAt('SELECT * FROM cli', 17), { kind: 'table' });
    assert.deepEqual(contextAt('SELECT c. FROM clients c', 9), { kind: 'column', qualifier: 'c' });
    assert.deepEqual(contextAt('SELECT * FROM t WHERE ', 22), { kind: 'column' });
    assert.deepEqual(contextAt("SELECT * FROM t WHERE nom = 'ab", 31), { kind: 'none' });
    assert.deepEqual(contextAt('SELECT * FROM t JOIN ', 21), { kind: 'table' });
  });
});
