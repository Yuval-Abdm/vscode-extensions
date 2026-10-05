import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WorkspaceEdit } from 'vscode-languageserver/node';
import { prepareRename, renameAt } from '../src/server/refactor/rename.ts';
import { refEnv } from './refactor-env.ts';

const notLibrary = () => false;

/** Textes après application des modifications, par fichier relatif. */
function applied(edit: WorkspaceEdit, texts: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    const rel = uri.slice(uri.indexOf('/p/') + 3);
    const lines = texts[rel].split('\n');
    const offset = (p: { line: number; character: number }) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
    let text = texts[rel];
    for (const e of [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start))) text = text.slice(0, offset(e.range.start)) + e.newText + text.slice(offset(e.range.end));
    out[rel] = text;
  }
  return out;
}

describe('renommer', () => {
  it('classe : déclaration, use (alias gardé), new, extends, types, phpdoc, chaîne Classe::methode', async () => {
    const files = {
      'lib/User.php': '<?php\nnamespace Lib;\nclass User { public static function make() {} }\n',
      'lib/Admin.php': '<?php\nnamespace Lib;\nclass Admin extends User {}\n',
      'page.php': "<?php\nuse Lib\\User;\nuse Lib\\User as U;\n/** @var User $u */\n$u = new User();\nfunction f(User $x): User { return $x; }\ncall_user_func('Lib\\User::make');\n$v = new U();\n",
    };
    const { env, file } = await refEnv(files);
    const edit = renameAt(env, file('page.php'), { line: 4, character: 10 }, 'Member', notLibrary) as WorkspaceEdit;
    assert.deepEqual(applied(edit, files), {
      'lib/User.php': '<?php\nnamespace Lib;\nclass Member { public static function make() {} }\n',
      'lib/Admin.php': '<?php\nnamespace Lib;\nclass Admin extends Member {}\n',
      'page.php': "<?php\nuse Lib\\Member;\nuse Lib\\Member as U;\n/** @var Member $u */\n$u = new Member();\nfunction f(Member $x): Member { return $x; }\ncall_user_func('Lib\\Member::make');\n$v = new U();\n",
    });
  });

  it('méthode et propriété (déclaration avec $, accès sans $)', async () => {
    const files = { 'a.php': '<?php\nclass A {\n    public $total;\n    public function sum() { return $this->total; }\n}\n$a = new A();\necho $a->sum(), $a->total;\n' };
    const { env, file } = await refEnv(files);
    const method = renameAt(env, file('a.php'), { line: 6, character: 10 }, 'compute', notLibrary) as WorkspaceEdit;
    assert.equal(applied(method, files)['a.php'], '<?php\nclass A {\n    public $total;\n    public function compute() { return $this->total; }\n}\n$a = new A();\necho $a->compute(), $a->total;\n');
    const property = renameAt(env, file('a.php'), { line: 2, character: 13 }, 'amount', notLibrary) as WorkspaceEdit;
    assert.equal(applied(property, files)['a.php'], '<?php\nclass A {\n    public $amount;\n    public function sum() { return $this->amount; }\n}\n$a = new A();\necho $a->sum(), $a->amount;\n');
  });

  it('paramètre : corps de la fonction et arguments nommés des appels', async () => {
    const files = { 'f.php': '<?php\nfunction price($amount, $rate = 1) { return $amount * $rate; }\necho price(amount: 10, rate: 2), price(5);\n' };
    const { env, file } = await refEnv(files);
    const edit = renameAt(env, file('f.php'), { line: 1, character: 17 }, '$total', notLibrary) as WorkspaceEdit;
    assert.equal(applied(edit, files)['f.php'], '<?php\nfunction price($total, $rate = 1) { return $total * $rate; }\necho price(total: 10, rate: 2), price(5);\n');
  });

  it('variable du niveau fichier dans la chaîne d’inclusion', async () => {
    const files = { 'c.php': '<?php\n$db = 1;\n', 'p.php': "<?php\ninclude 'c.php';\necho $db;\n" };
    const { env, file } = await refEnv(files);
    const edit = renameAt(env, file('p.php'), { line: 2, character: 6 }, 'pdo', notLibrary) as WorkspaceEdit;
    assert.deepEqual(applied(edit, files), { 'c.php': '<?php\n$pdo = 1;\n', 'p.php': "<?php\ninclude 'c.php';\necho $pdo;\n" });
  });

  it('refus : fonction native, librairie, $this, nom invalide', async () => {
    const { env, file } = await refEnv({ 'a.php': "<?php\nusort($t, 'x');\nclass A { function f() { return $this; } }\nfunction g() {}\ng();\n", 'vendor/lib.php': '<?php function libfn() {}', 'b.php': '<?php libfn();' });
    assert.match((prepareRename(env, file('a.php'), { line: 1, character: 2 }, notLibrary) as { error: string }).error, /built-in/i);
    assert.match((prepareRename(env, file('b.php'), { line: 0, character: 7 }, (uri) => uri.includes('/vendor/')) as { error: string }).error, /library/i);
    assert.ok('error' in prepareRename(env, file('a.php'), { line: 2, character: 34 }, notLibrary));
    assert.deepEqual(prepareRename(env, file('a.php'), { line: 4, character: 0 }, notLibrary), { range: { start: { line: 4, character: 0 }, end: { line: 4, character: 1 } }, placeholder: 'g' });
    assert.ok('error' in renameAt(env, file('a.php'), { line: 4, character: 0 }, '9bad', notLibrary));
  });
});
