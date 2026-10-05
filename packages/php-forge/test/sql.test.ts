import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sqlTokens } from '../src/server/sql/tokens.ts';
import { parse } from './helpers.ts';

/** Jetons SQL sous forme lisible : « ligne:colonne type texte ». */
async function tokens(code: string): Promise<string[]> {
  const lines = code.split('\n');
  return sqlTokens(await parse(code)).map((t) => `${t.line}:${t.character} ${t.type} ${lines[t.line].slice(t.character, t.character + t.length)}`);
}

const words = async (code: string) => (await tokens(code)).map((t) => t.split(' ').slice(1).join(' '));

describe('SQL dans les chaînes', () => {
  it('requête concaténée : la suite après une variable reste du SQL (cas du CRM)', async () => {
    const code = [
      '<?php',
      "$select_mdrForInfo = ' SELECT id_MR",
      '                        FROM   rp_facilitiesForBilan',
      "                        WHERE  id_client = '.$id_client.'",
      "                        GROUP BY id_MR ORDER BY id_MR';",
    ].join('\n');
    assert.deepEqual(await tokens(code), [
      '1:23 keyword SELECT',
      '2:24 keyword FROM',
      '3:24 keyword WHERE',
      '4:24 keyword GROUP', '4:30 keyword BY', '4:39 keyword ORDER', '4:45 keyword BY',
    ]);
  });

  it('texte ordinaire : rien', async () => {
    assert.deepEqual(await tokens("<?php $m = 'COUNT Clients recus'; $n = 'Select a client from the list'; $o = 'ON';"), []);
  });

  it('suite ajoutée avec .= à une variable SQL', async () => {
    assert.deepEqual(await words('<?php\n$sql = "SELECT a FROM t";\nif ($x) $sql .= " WHERE b = 1";\n$msg = "x";\n$msg .= " and more";'), [
      'keyword SELECT', 'keyword FROM', 'keyword WHERE', 'number 1',
    ]);
  });

  it('.= dans une autre fonction : variable différente', async () => {
    assert.deepEqual(await words('<?php\n$sql = "SELECT a FROM t";\nfunction f() { $sql .= " or not"; }'), ['keyword SELECT', 'keyword FROM']);
  });

  it('argument des fonctions de requête, même sans mot-clé de début', async () => {
    assert.deepEqual(await words("<?php rp_query('SET group_concat_max_len = 10000', 'query'); $db->query(\"UPDATE t SET a = 1\");"), [
      'keyword SET', 'number 10000', 'keyword UPDATE', 'keyword SET', 'number 1',
    ]);
  });

  it('argument de la requête : le premier, ou le second après la connexion (mysqli_query, pg_query)', async () => {
    assert.deepEqual(await words("<?php rp_query($sql, 'query'); rp_query('DELETE FROM t', 'exec'); mysqli_query($db, 'SELECT 1', 'x'); $db->query($q, 'fetch');"), [
      'keyword DELETE', 'keyword FROM', 'keyword SELECT', 'number 1',
    ]);
  });

  it('valeurs entre guillemets SQL ignorées, y compris à cheval sur une concaténation', async () => {
    assert.deepEqual(await words(`<?php $s = "SELECT a FROM t WHERE nom = 'AND' OR x = \\"FROM\\"";`), ['keyword SELECT', 'keyword FROM', 'keyword WHERE', 'keyword OR']);
    assert.deepEqual(await words("<?php $s = 'SELECT a FROM t WHERE a = \\''.$x.'\\' AND b = 2';"), ['keyword SELECT', 'keyword FROM', 'keyword WHERE', 'keyword AND', 'number 2']);
  });

  it('fonctions SQL suivies de « ( », colonnes au nom de mot-clé ignorées', async () => {
    assert.deepEqual(await words("<?php $s = 'SELECT COUNT(*), IF (a IS NULL, 0, 1), DATE(d), date, t.order FROM t';"), [
      'keyword SELECT', 'function COUNT', 'function IF', 'keyword IS', 'keyword NULL', 'number 0', 'number 1', 'function DATE', 'keyword FROM',
    ]);
  });

  it('nombres seuls, pas dans les identifiants', async () => {
    assert.deepEqual(await words("<?php $s = 'SELECT id_10 FROM t LIMIT 10, 2.5';"), ['keyword SELECT', 'keyword FROM', 'keyword LIMIT', 'number 10', 'number 2.5']);
  });

  it('SQL en minuscules reconnu à sa structure', async () => {
    assert.deepEqual(await words("<?php $s = 'select a from t where b = 1';"), ['keyword select', 'keyword from', 'keyword where', 'number 1']);
  });

  it('heredoc', async () => {
    assert.deepEqual(await words('<?php $s = <<<SQL\nSELECT a FROM t WHERE id = $id\nSQL;\n'), ['keyword SELECT', 'keyword FROM', 'keyword WHERE']);
  });

  it('sous-requête entre parenthèses', async () => {
    assert.deepEqual(await words("<?php $s = '(SELECT a FROM t)';"), ['keyword SELECT', 'keyword FROM']);
  });
});
