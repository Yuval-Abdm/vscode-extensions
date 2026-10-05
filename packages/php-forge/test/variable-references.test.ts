import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { variableReferences, variableTarget } from '../src/server/refactor/variables.ts';
import { refEnv, where } from './refactor-env.ts';

describe('références de variables', () => {
  it('variable locale : sa fonction seulement', async () => {
    const { env, file } = await refEnv({ 'f.php': '<?php\n$x = 1;\nfunction f($x) {\n    $y = $x + 1;\n    return $x;\n}\necho $x;\n' });
    const target = variableTarget(file('f.php'), { line: 3, character: 10 })!;
    assert.equal(target.fileLevel, false);
    assert.deepEqual(where(variableReferences(env, file('f.php'), target)), ['f.php:2:12', 'f.php:3:10', 'f.php:4:12']);
  });

  it('variable du niveau fichier : la chaîne d’inclusion, global et $GLOBALS ; pas les variables homonymes des fonctions', async () => {
    const { env, file } = await refEnv({
      'connexion.php': '<?php\n$db = new PDO("x");\n',
      'page.php': "<?php\ninclude 'connexion.php';\n$db->query('a');\nfunction q() {\n    global $db;\n    return $db;\n}\nfunction other() {\n    $db = 1;\n    return $GLOBALS['db'];\n}\n",
      'unrelated.php': '<?php\n$db = 2;\n',
    });
    const target = variableTarget(file('page.php'), { line: 2, character: 1 })!;
    assert.equal(target.fileLevel, true);
    assert.deepEqual(where(variableReferences(env, file('page.php'), target)), [
      'connexion.php:1:1', 'page.php:2:1', 'page.php:4:12', 'page.php:5:12', 'page.php:9:21',
    ]);
  });

  it('$this et superglobales : pas une cible', async () => {
    const { file } = await refEnv({ 'a.php': '<?php\necho $_POST["a"];\nclass A { function f() { return $this; } }\n' });
    assert.equal(variableTarget(file('a.php'), { line: 1, character: 6 }), undefined);
    assert.equal(variableTarget(file('a.php'), { line: 2, character: 33 }), undefined);
  });

  it('pages qui partagent seulement un en-tête : variables indépendantes', async () => {
    const { env, file } = await refEnv({
      'header.php': '<?php\n$title = "x";\n',
      'p1.php': "<?php\ninclude 'header.php';\n$row = 1;\n",
      'p2.php': "<?php\ninclude 'header.php';\n$row = 2;\n",
    });
    const target = variableTarget(file('p1.php'), { line: 2, character: 2 })!;
    assert.deepEqual(where(variableReferences(env, file('p1.php'), target)), ['p1.php:2:1']);
  });
});
