import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { securityDiagnostics } from '../src/server/security/diagnostics.ts';
import { returnsData, type TaintEnv } from '../src/server/security/taint.ts';
import { parse } from './helpers.ts';

const URI = 'file:///p/page.php';

async function found(code: string, env: Partial<TaintEnv> = {}): Promise<string[]> {
  const diagnostics = securityDiagnostics(await parse(code), { uri: URI, ...env });
  return diagnostics.map((d) => `${d.range.start.line}:${String(d.code).replace('security-', '')}`);
}

async function messages(code: string, env: Partial<TaintEnv> = {}): Promise<string[]> {
  return securityDiagnostics(await parse(code), { uri: URI, ...env }).map((d) => String(d.message));
}

describe('sécurité : propagation jusqu’aux points sensibles', () => {
  it('injection SQL, avec le chemin de propagation', async () => {
    const code = `<?php\n$id = $_POST['id'];\n\n$sql = "SELECT * FROM t WHERE id = " . $id;\nmysqli_query($db, $sql);\n`;
    assert.deepEqual(await found(code), ['4:sql-injection']);
    assert.deepEqual(await messages(code), [`Possible SQL injection: $_POST['id'] (line 2) → $id → $sql (line 4) → mysqli_query (line 5)`]);
  });

  it('chaque point sensible', async () => {
    const code = [
      '<?php',
      '$q = $_GET["q"];',
      'echo "<p>" . $q;',
      'print $q;',
      'system("ls " . $q);',
      'include $q . ".php";',
      'unserialize($_COOKIE["c"]);',
      'header("Location: " . $q);',
      'move_uploaded_file($_FILES["f"]["tmp_name"], "up/" . $_FILES["f"]["name"]);',
      '$out = `grep $q file`;',
      '$db->query("DELETE FROM t WHERE id = $q");',
      '?>',
      '<a><?= $q ?></a>',
    ].join('\n');
    assert.deepEqual(await found(code), ['2:xss', '3:xss', '4:command-injection', '5:file-inclusion', '6:unsafe-unserialize', '7:open-redirect', '8:path-traversal', '9:command-injection', '10:sql-injection', '12:xss']);
  });

  it('neutraliseurs selon le point sensible', async () => {
    const code = [
      '<?php',
      '$id = (int)$_GET["id"];',
      'mysqli_query($db, "SELECT * FROM t WHERE id = $id");',
      '$n = htmlspecialchars($_GET["n"]);',
      'echo $n;',
      'mysqli_query($db, "SELECT * FROM t WHERE n = \'$n\'");',
      '$e = mysqli_real_escape_string($db, $_GET["e"]);',
      'mysqli_query($db, "SELECT * FROM t WHERE e = \'" . $e . "\'");',
      'mysqli_query($db, "SELECT * FROM t WHERE e = $e");',
      'system("ls " . escapeshellarg($_GET["d"]));',
      'include "pages/" . basename($_GET["p"]) . ".php";',
      'echo intval($_GET["i"]) + count($_POST);',
      '$f = filter_var($_GET["f"], FILTER_VALIDATE_INT);',
      'mysqli_query($db, "SELECT $f");',
    ].join('\n');
    // htmlspecialchars ne protège pas le SQL ; l'échappement SQL hors quotes non plus
    assert.deepEqual(await found(code), ['5:sql-injection', '8:sql-injection']);
  });

  it('gardes : in_array strict sur une liste, is_numeric, sortie anticipée', async () => {
    const code = [
      '<?php',
      '$t = $_GET["t"];',
      'if (in_array($t, ["a", "b"], true)) { echo $t; }',
      'if (is_numeric($t)) { mysqli_query($db, "SELECT $t"); } else { echo $t; }',
      '$u = $_GET["u"];',
      'if (!ctype_digit($u)) { exit; }',
      'mysqli_query($db, "SELECT $u");',
      '$v = $_GET["v"];',
      'if (in_array($v, $allowed)) { echo $v; }',
    ].join('\n');
    assert.deepEqual(await found(code), ['3:xss', '8:xss']);
  });

  it('branches réunies, boucles, réaffectation propre', async () => {
    const code = [
      '<?php',
      'if ($a) { $x = $_GET["x"]; } else { $x = "ok"; }',
      'echo $x;',
      '$y = $_GET["y"];',
      '$y = 5;',
      'echo $y;',
      'foreach ($_POST as $k => $v) { $list .= $v; }',
      'echo $list;',
      'while ($row = mysqli_fetch_assoc($r)) { echo $row["nom"]; }',
    ].join('\n');
    assert.deepEqual(await found(code), ['2:xss', '7:xss']);
  });

  it('extract($_POST) : les variables non affectées viennent de la requête', async () => {
    const code = `<?php\nextract($_POST);\n$ok = 1;\necho $nom . $ok;\n`;
    assert.deepEqual(await messages(code), ['Request data written to the page without escaping (XSS): extract($_POST) (line 2) → $nom (line 4) → echo']);
  });

  it('variable venue d’un fichier qui inclut celui-ci (moteur d’inclusion)', async () => {
    const request = (name: string) => (name === '$nom' ? { from: '$_POST', line: 3 } : undefined);
    assert.deepEqual(await found(`<?php\necho $nom . $autre;\n`, { request }), ['1:xss']);
  });

  it('fonction du fichier appelée avec une donnée de la requête : signalée à l’appel', async () => {
    const code = [
      '<?php',
      'function charge($id) {',
      '  $sql = "SELECT * FROM t WHERE id = " . $id;',
      '  return mysqli_query($GLOBALS["db"], $sql);',
      '}',
      'function propre($s) { return (int)$s; }',
      'function passe($s) { return trim($s); }',
      'charge($_GET["id"]);',
      'charge(5);',
      'echo propre($_GET["a"]);',
      'echo passe($_GET["b"]);',
    ].join('\n');
    assert.deepEqual(await found(code), ['7:sql-injection', '10:xss']);
    const [message] = await messages(code);
    assert.equal(message, `Possible SQL injection: $_GET["id"] (line 8) → charge() → $sql (line 3) → mysqli_query (line 4)`);
  });

  it('méthode de la même classe ; fonction d’un autre fichier ; profondeur bornée', async () => {
    const lib = await parse('<?php\nfunction exec_sql($q) {\n  mysql_query($q);\n}\n');
    const loadFunction = (name: string) => (name === 'exec_sql' ? { uri: 'file:///p/lib/db.php', node: lib.rootNode.descendantsOfType('function_definition')[0], release() {} } : undefined);
    const code = [
      '<?php',
      'class Repo {',
      '  function find($id) { return $this->run("SELECT * FROM t WHERE id = $id"); }',
      '  private function run($sql) { return $this->db->query($sql); }',
      '}',
      '$r = new Repo();',
      'exec_sql("DELETE FROM t WHERE id = " . $_GET["id"]);',
    ].join('\n');
    assert.deepEqual(await found(code, { loadFunction }), ['6:sql-injection']);
    assert.match((await messages(code, { loadFunction }))[0], /exec_sql\(\) → mysql_query \(db\.php:3\)$/);
    // Méthode appelée avec un paramètre : rien tant qu'aucune donnée de la requête n'y entre
    assert.deepEqual(await found(`<?php\nclass A {\n  function f() { $this->g($_GET["x"]); }\n  function g($v) { echo $v; }\n}\n`), ['2:xss']);
  });

  it('neutraliseurs personnalisés (phpForge.security.sanitizers)', async () => {
    const code = `<?php\necho rp_clean($_GET["a"]);\necho Html::esc($_GET["b"]);\necho trim($_GET["c"]);\n`;
    assert.deepEqual(await found(code, { sanitizers: ['rp_clean', 'html::esc'] }), ['3:xss']);
  });

  it('chemin affiché : la donnée la moins neutralisée de la requête', async () => {
    const code = `<?php\n$a = addslashes($_POST['a']);\n$id = $_POST['id'];\n$q = "UPDATE t SET a = '" . $a . "' WHERE id = " . $id;\nmysqli_query($db, $q);\n`;
    assert.deepEqual(await messages(code), [`Possible SQL injection: $_POST['id'] (line 3) → $id → $q (line 4) → mysqli_query (line 5)`]);
  });

  it('portée sans source : jamais parcourue (le moteur d’inclusion n’est pas interrogé)', async () => {
    let asked = 0;
    const request = () => {
      asked++;
      return undefined;
    };
    assert.deepEqual(await found(`<?php\nfunction f($a) { echo $a; }\necho $b;\n`, { request, requestAtEntry: () => false }), []);
    assert.equal(asked, 0);
    // Variable venue d'un fichier qui inclut celui-ci : le niveau fichier est parcouru
    assert.deepEqual(await found(`<?php\necho $b;\n`, { request: () => ({ from: '$_POST', line: 1 }), requestAtEntry: () => true }), ['1:xss']);
  });

  it('fonctions récursives appelées avec une donnée de la requête : pas de boucle infinie', async () => {
    const code = `<?php\nfunction a($x) { return b($x); }\nfunction b($y) { echo $y; return a($y); }\na($_GET['v']);\n`;
    assert.deepEqual(await found(code), ['3:xss']);
  });

  it('$_SERVER et $_FILES : seulement les clés que le client choisit', async () => {
    const code = `<?php\necho $_SERVER["DOCUMENT_ROOT"];\necho $_SERVER["HTTP_REFERER"];\necho $_FILES["f"]["tmp_name"];\necho $_FILES["f"]["name"];\n`;
    assert.deepEqual(await found(code), ['2:xss', '4:xss']);
  });
});

describe('sécurité : revue 0.8', () => {
  it('fonctions natives qui transmettent la donnée (liste, puis stubs : chaîne ou tableau rendu)', async () => {
    const code = [
      '<?php',
      'mysql_query("SELECT * FROM t WHERE x = \'" . strip_tags($_GET["x"]) . "\'");',
      'echo strtr($_GET["a"], "a", "b");',
      'echo ucwords(strip_tags($_GET["y"]));',
      'echo array_column($_POST["rows"], "n")[0];',
      'echo grapheme_substr($_GET["w"], 0, 10);',
      'echo str_word_count($_GET["c"]);',
    ].join('\n');
    const native = (name: string) => (name === 'grapheme_substr' ? true : name === 'str_word_count' ? false : undefined);
    assert.deepEqual(await found(code, { native }), ['1:sql-injection', '2:xss', '3:xss', '4:xss', '5:xss']);
  });

  it('type rendu par une native : chaîne, tableau, mixed transmettent ; nombre, booléen, objet non', () => {
    assert.deepEqual([undefined, { kind: 'scalar', name: 'string' }, { kind: 'array' }, { kind: 'union', types: [{ kind: 'scalar', name: 'string' }, { kind: 'scalar', name: 'false' }] }].map((t) => returnsData(t as never)), [true, true, true, true]);
    assert.deepEqual([{ kind: 'scalar', name: 'int' }, { kind: 'scalar', name: 'bool' }, { kind: 'class', fqn: 'DateTime' }].map((t) => returnsData(t as never)), [false, false, false]);
  });

  it('fonction qui lit elle-même la requête (getter) : sa valeur rendue vient de la requête', async () => {
    const code = [
      '<?php',
      'function get($n) { return isset($_GET[$n]) ? $_GET[$n] : ""; }',
      '$id = get("id");',
      'mysql_query("SELECT * FROM t WHERE id = $id");',
      'echo get("name");',
      'echo intval(get("n"));',
      'function propre() { return 42; }',
      'echo propre();',
    ].join('\n');
    assert.deepEqual(await found(code), ['3:sql-injection', '4:xss']);
    assert.match((await messages(code))[0], /^Possible SQL injection: \$_GET\[\$n\] \(line 2\) → get\(\) \(line 3\) → \$id → mysql_query \(line 4\)$/);
    // Autre fichier : seulement si l'index dit que la fonction lit la requête
    const lib = await parse('<?php\nfunction param($k) {\n  return $_POST[$k];\n}\n');
    const loadFunction = () => ({ uri: 'file:///p/lib.php', node: lib.rootNode.descendantsOfType('function_definition')[0], release() {} });
    assert.deepEqual(await found('<?php\necho param("a");\n', { loadFunction, readsRequest: () => true }), ['1:xss']);
    assert.deepEqual(await found('<?php\necho param("a");\n', { loadFunction, readsRequest: () => false }), []);
  });

  it('valeur échappée dans un littéral SQL (LIKE \'%…%\') : sûre ; hors littéral : signalée', async () => {
    const code = [
      '<?php',
      '$q = mysql_real_escape_string($_GET["q"]);',
      'mysql_query("SELECT * FROM t WHERE nom LIKE \'%$q%\'");',
      'mysql_query("SELECT * FROM t WHERE nom LIKE \'%" . $q . "%\' AND a = \'x\'");',
      'mysql_query("SELECT * FROM t WHERE a = \'x\' AND id = " . $q);',
    ].join('\n');
    assert.deepEqual(await found(code), ['4:sql-injection']);
  });

  it('gardes sur $_GET[…] directement, et combinées par || (sortie) ou && (branche)', async () => {
    const code = [
      '<?php',
      'if (!is_numeric($_GET["id"])) die();',
      'mysql_query("SELECT * FROM t WHERE id = " . $_GET["id"]);',
      '$n = $_GET["n"];',
      'if (!isset($n) || !is_numeric($n)) { exit; }',
      'mysql_query("SELECT * FROM t WHERE n = $n");',
      '$p = $_GET["p"];',
      'if (isset($p) && ctype_digit($p)) { echo $p; }',
      'echo $p;',
    ].join('\n');
    assert.deepEqual(await found(code), ['8:xss']);
  });

  it('@, match, die / exit', async () => {
    const code = [
      '<?php',
      '$id = @$_GET["id"];',
      'mysql_query("SELECT * FROM t WHERE id = $id");',
      'echo @$_GET["x"];',
      '$m = match ($a) { 1 => $_GET["m"], default => "ok" };',
      'echo $m;',
      'die("Erreur : " . $_GET["e"]);',
      'exit($_GET["f"]);',
    ].join('\n');
    assert.deepEqual(await found(code), ['2:sql-injection', '3:xss', '5:xss', '6:xss', '7:xss']);
  });
});

describe('sécurité : résumés partagés', () => {
  it('fonction d’un autre fichier résumée une fois pour tous les fichiers analysés', async () => {
    const lib = await parse('<?php\nfunction run_sql($q) {\n  mysql_query($q);\n}\n');
    let loads = 0;
    const loadFunction = () => {
      loads++;
      return { uri: 'file:///p/lib.php', node: lib.rootNode.descendantsOfType('function_definition')[0], release() {} };
    };
    const store = new Map();
    const summaries = { get: (n: string, d: number) => store.get(`${n}@${d}`), set: (n: string, d: number, s: unknown) => store.set(`${n}@${d}`, s) };
    for (const file of ['a', 'b', 'c']) assert.deepEqual(await found(`<?php\nrun_sql("DELETE FROM t WHERE id = " . $_GET["${file}"]);\n`, { loadFunction, summaries: summaries as never }), ['1:sql-injection']);
    assert.equal(loads, 1);
  });
});
