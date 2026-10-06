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

  it('méthode : redéfinitions et implémentations renommées avec elle', async () => {
    const files = {
      'a.php': '<?php\ninterface Shape { public function area(); }\nclass Sq implements Shape { public function area() { return 1; } }\nclass Ci implements Shape { public function area() { return 2; } }\nclass Base { function save() {} }\nclass Child extends Base { function save() { parent::save(); } }\n$c = new Child();\n$c->save();\n$s = new Sq();\n$s->area();\n',
    };
    const { env, file } = await refEnv(files);
    const area = renameAt(env, file('a.php'), { line: 1, character: 37 }, 'surface', notLibrary) as WorkspaceEdit;
    assert.equal(applied(area, files)['a.php'].match(/surface/g)?.length, 4);
    const save = renameAt(env, file('a.php'), { line: 4, character: 23 }, 'store', notLibrary) as WorkspaceEdit;
    assert.equal(applied(save, files)['a.php'].match(/store/g)?.length, 4);
    const siblings = { 's.php': '<?php\nclass M {}\nclass A1 extends M { function go() {} }\nclass A2 extends M { function go() {} }\n' };
    const sib = await refEnv(siblings);
    const go = renameAt(sib.env, sib.file('s.php'), { line: 2, character: 31 }, 'run', notLibrary) as WorkspaceEdit;
    assert.equal(applied(go, siblings)['s.php'], '<?php\nclass M {}\nclass A1 extends M { function run() {} }\nclass A2 extends M { function go() {} }\n');
  });

  it('constante define() : déclaration, defined() et usages', async () => {
    const files = { 'c.php': "<?php\ndefine('MAX_ROWS', 10);\nif (defined('MAX_ROWS')) echo MAX_ROWS;\n" };
    const { env, file } = await refEnv(files);
    const fromUse = renameAt(env, file('c.php'), { line: 2, character: 33 }, 'MAX_LINES', notLibrary) as WorkspaceEdit;
    assert.equal(applied(fromUse, files)['c.php'], "<?php\ndefine('MAX_LINES', 10);\nif (defined('MAX_LINES')) echo MAX_LINES;\n");
    const fromDefine = renameAt(env, file('c.php'), { line: 1, character: 10 }, 'MAX_LINES', notLibrary) as WorkspaceEdit;
    assert.equal(applied(fromDefine, files)['c.php'], "<?php\ndefine('MAX_LINES', 10);\nif (defined('MAX_LINES')) echo MAX_LINES;\n");
  });

  it('variable capturée par une closure (use) ou une fonction fléchée', async () => {
    const files = { 'v.php': '<?php\n$db = 1;\n$f = function () use ($db) { return $db; };\n$g = fn($x) => $x + $db;\nfunction h() { $db = 2; return $db; }\n' };
    const { env, file } = await refEnv(files);
    const outer = renameAt(env, file('v.php'), { line: 1, character: 2 }, 'pdo', notLibrary) as WorkspaceEdit;
    assert.equal(applied(outer, files)['v.php'], '<?php\n$pdo = 1;\n$f = function () use ($pdo) { return $pdo; };\n$g = fn($x) => $x + $pdo;\nfunction h() { $db = 2; return $db; }\n');
    const inner = renameAt(env, file('v.php'), { line: 2, character: 38 }, 'pdo', notLibrary) as WorkspaceEdit;
    assert.equal(applied(inner, files)['v.php'], applied(outer, files)['v.php']);
  });

  it('méthode d’une classe PHP de même nom : objet de type inconnu pas renommé', async () => {
    const files = { 'm.php': '<?php\nclass Cache { public function get($k) {} }\n$m = make();\n$m->get("x");\n' };
    const { env, file } = await refEnv(files, '<?php class Memcached { public function get($k) {} }');
    const edit = renameAt(env, file('m.php'), { line: 1, character: 31 }, 'fetch', notLibrary) as WorkspaceEdit;
    assert.equal(applied(edit, files)['m.php'], '<?php\nclass Cache { public function fetch($k) {} }\n$m = make();\n$m->get("x");\n');
  });

  it('paramètre : chaque fichier d’appel lu une fois', async () => {
    const files = { 'f.php': '<?php\nfunction price($amount) { return $amount; }\n', 'g.php': '<?php\nprice(amount: 1);\nprice(amount: 2);\nprice(amount: 3);\n' };
    const { env, file, uriOf } = await refEnv(files);
    let reads = 0;
    const source = env.source;
    env.source = (uri) => {
      if (uri === uriOf('g.php')) reads++;
      return source(uri);
    };
    const edit = renameAt(env, file('f.php'), { line: 1, character: 17 }, 'total', notLibrary) as WorkspaceEdit;
    assert.equal(applied(edit, files)['g.php'], '<?php\nprice(total: 1);\nprice(total: 2);\nprice(total: 3);\n');
    assert.ok(reads <= 2, `${reads} lectures`);
  });
});
