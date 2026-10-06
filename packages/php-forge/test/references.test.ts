import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findReferences, targetAt } from '../src/server/refactor/references.ts';
import { refEnv, where } from './refactor-env.ts';

const FILES = {
  'lib/User.php': '<?php\nnamespace Lib;\nclass User {\n    public $name;\n    const ROLE = 1;\n    public function save() { return $this->name; }\n}\n',
  'lib/Admin.php': '<?php\nnamespace Lib;\nclass Admin extends User {}\n',
  'other/User.php': '<?php\nnamespace Other;\nclass User { public function save() {} }\n',
  'helpers.php': '<?php\nfunction format_price($p) { return $p; }\n',
  'page.php': [
    '<?php',
    'use Lib\\User;',
    '$u = new User();',
    '$u->save();',
    'echo $u->name, User::ROLE, format_price(1);',
    '$a = new \\Lib\\Admin();',
    '$a->save();',
    '$x = new \\Other\\User();',
    '$x->save();',
    '$unknown->save();',
    '',
  ].join('\n'),
};

describe('références', () => {
  it('classe : déclaration, use, new, extends ; pas la classe homonyme d’un autre namespace', async () => {
    const { env, file } = await refEnv(FILES);
    const target = targetAt(env, file('page.php'), { line: 2, character: 10 })!;
    assert.equal(target.kind, 'class');
    assert.deepEqual(where(findReferences(env, target, true)), ['lib/Admin.php:2:20', 'lib/User.php:2:6', 'page.php:1:8', 'page.php:2:9', 'page.php:4:15']);
    assert.deepEqual(where(findReferences(env, target, false)), ['lib/Admin.php:2:20', 'page.php:1:8', 'page.php:2:9', 'page.php:4:15']);
  });

  it('méthode : sur le type et ses sous-classes ; pas l’homonyme d’une autre classe ni un objet de type inconnu', async () => {
    const { env, file } = await refEnv(FILES);
    const target = targetAt(env, file('lib/User.php'), { line: 5, character: 22 })!;
    assert.equal(target.kind, 'method');
    assert.deepEqual(where(findReferences(env, target, true)), ['lib/User.php:5:20', 'page.php:3:4', 'page.php:6:4']);
  });

  it('propriété, constante de classe, fonction', async () => {
    const { env, file } = await refEnv(FILES);
    assert.deepEqual(where(findReferences(env, targetAt(env, file('lib/User.php'), { line: 3, character: 13 })!, true)), ['lib/User.php:3:12', 'lib/User.php:5:43', 'page.php:4:9']);
    assert.deepEqual(where(findReferences(env, targetAt(env, file('page.php'), { line: 4, character: 22 })!, true)), ['lib/User.php:4:10', 'page.php:4:21']);
    assert.deepEqual(where(findReferences(env, targetAt(env, file('page.php'), { line: 4, character: 30 })!, true)), ['helpers.php:1:9', 'page.php:4:27']);
  });

  it('fichier candidat qui ne nomme la fonction qu’en méthode ou en variable : jamais analysé', async () => {
    const { env, file } = await refEnv({ ...FILES, 'noise.php': '<?php\n$o->format_price(1);\nX::format_price();\n$format_price = 1;\n', 'call.php': "<?php\necho format_price(2);\ncall_user_func('format_price');\n" });
    const loaded: string[] = [];
    const source = env.source;
    env.source = (uri) => {
      loaded.push(uri.slice(uri.indexOf('/p/') + 3));
      return source(uri);
    };
    const target = targetAt(env, file('page.php'), { line: 4, character: 30 })!;
    assert.deepEqual(where(findReferences(env, target, true)), ['call.php:1:5', 'call.php:2:16', 'helpers.php:1:9', 'page.php:4:27']);
    assert.ok(!loaded.includes('noise.php'), loaded.join());
    // Fonction au nom de mot courant : le mot dans du HTML ou un commentaire ne suffit pas
    const words = await refEnv({ 'f.php': '<?php\nfunction type($x) { return $x; }\n', 'html.php': '<?php\n$o->type = 1; // type de contrat\n?>\n<input type="text">\n', 'use.php': '<?php\necho type(1);\n' });
    const seen: string[] = [];
    const wordSource = words.env.source;
    words.env.source = (uri) => {
      seen.push(uri.slice(uri.indexOf('/p/') + 3));
      return wordSource(uri);
    };
    assert.deepEqual(where(findReferences(words.env, targetAt(words.env, words.file('use.php'), { line: 1, character: 6 })!, true)), ['f.php:1:9', 'use.php:1:5']);
    assert.ok(!seen.includes('html.php'), seen.join());
  });

  it('fonction importée par un use groupé avec alias : référence gardée par le filtre', async () => {
    const { env, file } = await refEnv({ 'lib.php': '<?php\nnamespace Lib;\nfunction fmt($x) { return $x; }\n', 'u.php': '<?php\nuse Lib\\{function fmt as g};\necho g(1);\n', 'v.php': '<?php\nuse function Lib\\fmt;\necho fmt(2);\n' });
    assert.deepEqual(where(findReferences(env, targetAt(env, file('lib.php'), { line: 2, character: 10 })!, true)), ['lib.php:2:9', 'u.php:1:18', 'v.php:1:17', 'v.php:2:5']);
  });

  it('membre au nom unique dans le projet : appel sur un objet de type inconnu compté', async () => {
    const { env, file } = await refEnv({
      'a.php': '<?php\nclass Report { public function generatePdf() {} }\n',
      'b.php': '<?php\n$r = get_report();\n$r->generatePdf();\n',
    });
    const target = targetAt(env, file('a.php'), { line: 1, character: 35 })!;
    assert.deepEqual(where(findReferences(env, target, false)), ['b.php:2:4']);
  });
});
