import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findReferences, targetAt } from '../src/server/refactor/references.ts';
import { refEnv, where } from './refactor-env.ts';

describe('références dans les chaînes et les callables', () => {
  it('fonction passée par son nom à un callable connu, function_exists ; pas une chaîne quelconque', async () => {
    const { env, file } = await refEnv({
      'f.php': "<?php\nfunction cmp($a, $b) { return 0; }\nusort($t, 'cmp');\ncall_user_func('cmp', 1, 2);\nif (function_exists('cmp')) {}\necho 'cmp';\n",
    });
    const target = targetAt(env, file('f.php'), { line: 1, character: 10 })!;
    assert.deepEqual(where(findReferences(env, target, false)), ['f.php:2:11', 'f.php:3:16', 'f.php:4:21']);
  });

  it('« Classe::methode » et tableaux callables', async () => {
    const { env, file } = await refEnv({
      'c.php': [
        '<?php',
        'class Cron { public function run() {} public static function boot() {} }',
        "call_user_func('Cron::boot');",
        '$c = new Cron();',
        "call_user_func([$c, 'run']);",
        "call_user_func(['Cron', 'boot']);",
        "call_user_func([Cron::class, 'boot']);",
        "call_user_func([$other, 'run']);",
        "echo 'Other::boot';",
      ].join('\n'),
    });
    const boot = targetAt(env, file('c.php'), { line: 1, character: 63 })!;
    assert.deepEqual(where(findReferences(env, boot, false)), ['c.php:2:22', 'c.php:5:25', 'c.php:6:30']);
    const run = targetAt(env, file('c.php'), { line: 1, character: 30 })!;
    assert.deepEqual(where(findReferences(env, run, false)), ['c.php:4:21']);
  });

  it('chaîne seule dans un autre fichier : fichier candidat', async () => {
    const { env, file } = await refEnv({
      'c.php': '<?php\nclass Cron { public static function boot() {} }\nfunction cmp($a, $b) { return 0; }\n',
      'd.php': "<?php\ncall_user_func('Cron::boot');\nusort($t, 'cmp');\n",
    });
    assert.deepEqual(where(findReferences(env, targetAt(env, file('c.php'), { line: 1, character: 37 })!, false)), ['d.php:1:22']);
    assert.deepEqual(where(findReferences(env, targetAt(env, file('c.php'), { line: 2, character: 10 })!, false)), ['d.php:2:11']);
  });
});
