import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IncludeAnalysis, type AnalysisOptions } from '../src/server/includes/analysis.ts';
import { IncludeGraph } from '../src/server/includes/graph.ts';
import { Lookup } from '../src/server/index/lookup.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { extract } from './helpers.ts';
import { project, uriOf } from './project.ts';

const STUBS = "<?php function preg_match($pattern, $subject, &$matches = null, $flags = 0) {}\nfunction strlen($s) {}\nclass mysqli_stmt { function bind_result(&$var, &...$vars) {} }";

async function analyse(files: Record<string, string>, options: Partial<AnalysisOptions> = {}) {
  const index = await project(files);
  const stubs = new SymbolIndex();
  stubs.set(await extract(STUBS, 'phpstub:/standard/standard.php'));
  const graph = new IncludeGraph(index, { roots: ['/p'], readFile: () => undefined });
  const analysis = new IncludeAnalysis(index, new Lookup(index, stubs), graph, { maxContexts: 64, externalGlobals: [], ...options });
  analysis.run();
  return analysis;
}

/** Lectures signalées : « $nom kind [appelants] +autres ». */
function reads(analysis: IncludeAnalysis, rel: string): string[] {
  return (analysis.report(uriOf(rel))?.reads ?? []).map((r) => {
    const via = r.via.map((v) => (v === '' ? 'seul' : v === 'function' ? 'fonction' : `${v.slice(v.lastIndexOf('/') + 1)}`)).join(',');
    return `$${r.name} ${r.kind} [${via}]${r.others ? ` +${r.others}` : ''}`;
  });
}

describe('analyse des inclusions', () => {
  it('règle stricte : variable définie par certains appelants seulement', async () => {
    const analysis = await analyse({
      'lp_1/index.php': "<?php\n$title = 'A';\ninclude __DIR__.'/../header.php';",
      'lp_2/index.php': "<?php\n$title = 'B';\ninclude __DIR__.'/../header.php';",
      'lp_3/index.php': "<?php\ninclude __DIR__.'/../header.php';",
      'header.php': '<?php echo $title;',
    });
    assert.deepEqual(reads(analysis, 'header.php'), ['$title undefined [index.php#1] +2']);
    assert.deepEqual(analysis.report(uriOf('header.php'))?.reads[0].via, [`${uriOf('lp_3/index.php')}#1`]);
    assert.deepEqual(reads(analysis, 'lp_1/index.php'), []);
  });

  it('variables, types et origine venant d’un fichier inclus', async () => {
    const analysis = await analyse({
      'init.php': "<?php\n$db = new PDO('x');\n$site = 'crm';",
      'page.php': "<?php\ninclude 'init.php';\necho $site;\n$db->query('x');\n",
    });
    assert.deepEqual(reads(analysis, 'page.php'), []);
    const db = analysis.variable(uriOf('page.php'), 'db', { line: 3, character: 0 });
    assert.deepEqual(db, { certain: true, origin: { uri: uriOf('init.php'), line: 1 }, type: { kind: 'class', fqn: 'PDO' } });
    assert.equal(analysis.variable(uriOf('page.php'), 'db', { line: 1, character: 0 }), undefined);
    assert.deepEqual(analysis.names(uriOf('page.php'), { line: 4, character: 0 }).sort(), ['db', 'site']);
  });

  it('include conditionnel : peut-être définie (information)', async () => {
    const analysis = await analyse({
      'vars.php': '<?php $admin_menu = 1;',
      'page.php': "<?php\nif ($_GET['a']) { include 'vars.php'; }\necho $admin_menu;",
    });
    assert.deepEqual(reads(analysis, 'page.php'), ['$admin_menu maybe [seul]']);
  });

  it('variables du fichier inclus et de l’appelant vues dans l’ordre', async () => {
    const analysis = await analyse({
      'a.php': '<?php echo $before; echo $after;',
      'page.php': "<?php\n$before = 1;\ninclude 'a.php';\n$after = 2;",
    });
    assert.deepEqual(reads(analysis, 'a.php'), ['$after undefined [page.php#2]']);
  });

  it('include non résolu : signalé, plus d’alerte ensuite ; gabarits dynamiques silencieux', async () => {
    const analysis = await analyse({
      'page.php': "<?php\ninclude __DIR__.'/templates/'.$page.'.php';\necho $anything;\ninclude 'missing.php';",
      'templates/home.php': '<?php echo $title;',
    });
    assert.deepEqual(reads(analysis, 'page.php'), ['$page undefined [seul]']);
    assert.deepEqual(analysis.report(uriOf('page.php'))?.unresolved, [{ index: 0, evaluated: false }, { index: 1, evaluated: true }]);
    assert.deepEqual(reads(analysis, 'templates/home.php'), []);
  });

  it('include introuvable : signalé', async () => {
    const analysis = await analyse({ 'page.php': "<?php\ninclude 'missing.php';" });
    assert.deepEqual(analysis.report(uriOf('page.php'))?.unresolved, [{ index: 0, evaluated: true }]);
  });

  it('paramètres par référence (fonctions et méthodes), parse_str, gardes', async () => {
    const analysis = await analyse({
      'page.php': [
        '<?php',
        "preg_match('/x/', 's', $m); echo $m[0];",
        '$stmt->bind_result($a, $b); echo $a, $b;',
        'echo strlen($undefined);',
        "if (isset($x) && $x > 0) { echo $x; }",
        "$y = $z ?? '';",
        'if (!isset($w)) { $w = 1; } echo $w;',
        'unknown_fn($u); echo $u;',
      ].join('\n'),
    });
    assert.deepEqual(reads(analysis, 'page.php'), ['$stmt undefined [seul]', '$undefined undefined [seul]']);
  });

  it('extract($_POST) : variables inconnues acceptées, origine de la requête', async () => {
    const analysis = await analyse({ 'page.php': "<?php\nextract($_POST);\necho $nom;\n" });
    assert.deepEqual(reads(analysis, 'page.php'), []);
    assert.deepEqual(analysis.variable(uriOf('page.php'), 'nom', { line: 2, character: 5 }), { certain: true, request: { from: '$_POST', line: 1 } });
  });

  it('fonctions : portée propre, globales, paramètres', async () => {
    const analysis = await analyse({ 'page.php': "<?php\n$db = 1;\nfunction f($a) { global $db; return $a + $db + $b; }\n" });
    assert.deepEqual(reads(analysis, 'page.php'), ['$b undefined [fonction]']);
  });

  it('symboles non inclus, selon l’appelant', async () => {
    const analysis = await analyse({
      'helpers.php': '<?php function helper_fn() {}',
      'lib.php': '<?php echo helper_fn();',
      'a.php': "<?php include 'helpers.php'; include 'lib.php';",
      'b.php': "<?php include 'lib.php';",
      'c.php': '<?php echo helper_fn(); function local_fn() {} local_fn(); strlen("x");',
    });
    const lib = analysis.report(uriOf('lib.php'))!;
    assert.deepEqual(lib.symbols.map((s) => [s.need.name, s.via, s.others]), [['helper_fn', [`${uriOf('b.php')}#0`], 1]]);
    assert.deepEqual(analysis.report(uriOf('c.php'))!.symbols.map((s) => [s.need.name, s.need.declaredIn]), [['helper_fn', [uriOf('helpers.php')]]]);
  });

  it('contexte inconnu (gabarit dynamique, après un include non résolu) : pas de vérification des symboles', async () => {
    const analysis = await analyse({
      'helpers.php': '<?php function helper_fn() {}',
      'page.php': "<?php\ninclude __DIR__.'/parts/'.$tab.'.php';\nhelper_fn();",
      'parts/client.php': '<?php helper_fn();',
    });
    assert.deepEqual(analysis.report(uriOf('page.php'))!.symbols, []);
    assert.deepEqual(analysis.report(uriOf('parts/client.php'))!.symbols, []);
  });

  it('autoloader enregistré dans une méthode : classes chargées automatiquement', async () => {
    const analysis = await analyse({
      'Autoloader.php': '<?php class Autoloader { static function register() { spl_autoload_register(function ($c) {}); } }',
      'lib/Thing.php': '<?php class Thing {}',
      'page.php': "<?php include 'Autoloader.php'; Autoloader::register(); new Thing();",
    });
    assert.deepEqual(analysis.report(uriOf('page.php'))!.symbols, []);
  });

  it('symboles dans une fonction : vérifiés avec ce que la page a chargé à la fin', async () => {
    const analysis = await analyse({
      'lib.php': '<?php function f() { return new Data(); }',
      'Data.php': '<?php class Data {}',
      'page.php': "<?php include 'lib.php'; include 'Data.php'; f();",
      'page2.php': "<?php include 'lib.php'; f();",
      'page3.php': "<?php include 'lib.php'; include 'missing.php'; f();",
    });
    assert.deepEqual(analysis.report(uriOf('lib.php'))!.symbols.map((s) => [s.need.name, s.via, s.others]), [['Data', [`${uriOf('page2.php')}#0`], 2]]);
  });

  it('classes : autoload désactive la vérification', async () => {
    const analysis = await analyse({
      'A.php': '<?php class A {}',
      'page.php': '<?php spl_autoload_register(function ($c) {}); new A();',
    });
    assert.deepEqual(analysis.report(uriOf('page.php'))!.symbols, []);
  });

  it('inclusions circulaires et _once', async () => {
    const analysis = await analyse({
      'a.php': "<?php include 'b.php'; $x = 1;",
      'b.php': "<?php include 'a.php'; echo $y;",
      'page.php': "<?php require_once 'c.php'; require_once 'c.php'; echo $c;",
      'c.php': '<?php $c = 1;',
    });
    assert.ok(analysis.report(uriOf('b.php')));
    assert.deepEqual(reads(analysis, 'page.php'), []);
  });

  it('maxContexts : au-delà, analyse approximative', async () => {
    const analysis = await analyse({
      'p1.php': "<?php $a = 1; include 'h.php';",
      'p2.php': "<?php $b = 1; include 'h.php';",
      'h.php': '<?php echo $z;',
    }, { maxContexts: 1 });
    const report = analysis.report(uriOf('h.php'))!;
    assert.equal(report.approximate, true);
    assert.equal(report.reads.length, 1);
  });

  it('variables externes (réglage) et @var en tête de fichier', async () => {
    const analysis = await analyse({ 'page.php': '<?php\n/** @var PDO $pdo */\necho $config, $pdo;' }, { externalGlobals: ['$config'] });
    assert.deepEqual(reads(analysis, 'page.php'), []);
  });

  it('exit dans une branche : la suite ne voit que les chemins qui continuent', async () => {
    const analysis = await analyse({ 'page.php': "<?php\nif (!$ok) { exit; } else { $v = 1; }\necho $v, $ok;" });
    assert.deepEqual(reads(analysis, 'page.php'), ['$ok undefined [seul]', '$ok undefined [seul]']);
  });

  it('mémo : un require_once sauté dans un contexte ne fausse pas l’autre', async () => {
    const analysis = await analyse({
      'fonctions.php': '<?php function format_date() {}',
      'h.php': "<?php require_once 'fonctions.php';",
      'A.php': "<?php require_once 'fonctions.php'; include 'h.php'; format_date();",
      'B.php': "<?php include 'h.php'; format_date();",
    });
    assert.deepEqual(analysis.report(uriOf('B.php'))!.symbols, []);
  });

  it('mémo : autoloader et constantes du contexte pris en compte', async () => {
    const autoload = await analyse({
      'Autoloader.php': '<?php class Autoloader { static function register() { spl_autoload_register(function ($c) {}); } }',
      'lib/Thing.php': '<?php class Thing {}',
      'lib.php': '<?php new Thing();',
      'A.php': "<?php\n\ninclude 'lib.php';",
      'B.php': "<?php\ninclude 'Autoloader.php'; Autoloader::register();\n\ninclude 'lib.php';",
    });
    assert.deepEqual(autoload.report(uriOf('lib.php'))!.symbols.map((s) => s.via), [[`${uriOf('A.php')}#2`]]);
    const constants = await analyse({
      'lang/fr.php': "<?php $hello = 'bonjour';",
      'lang/en.php': "<?php $hello = 'hello'; $only_en = 1;",
      'render.php': "<?php include __DIR__ . '/lang/' . LANG . '.php';",
      'A.php': "<?php define('LANG', 'fr'); include 'render.php'; echo $hello;",
      'B.php': "<?php define('LANG', 'en'); include 'render.php'; echo $hello, $only_en;",
    });
    assert.deepEqual(reads(constants, 'B.php'), []);
  });

  it('includes dans des fonctions (chargement à la demande) : symboles considérés chargés', async () => {
    const analysis = await analyse({
      'db.php': '<?php function db_query($q) {}',
      'models/Model.php': '<?php class Model {}',
      'init.php': "<?php function connectDB() { require_once __DIR__ . '/db.php'; } function loadModel($n) { require_once __DIR__ . '/models/' . $n . '.php'; }",
      'page.php': "<?php include 'init.php'; connectDB(); $x = db_query('x'); $o = new Model();",
    });
    assert.deepEqual(analysis.report(uriOf('page.php'))!.symbols, []);
  });

  it('fichier inclus que le graphe ne résout pas (chemin relatif au script d’entrée) : pas de contexte « seul » en plus', async () => {
    const analysis = await analyse({
      'site/inc/b.php': '<?php echo $title;',
      'site/index.php': "<?php $title = 'x'; include 'inc/a.php';",
      'site/inc/a.php': "<?php include 'inc/b.php';",
    });
    assert.deepEqual(reads(analysis, 'site/inc/b.php'), []);
  });

  it('au-delà de maxContexts : contextes rattachés à une analyse commune, règle stricte maintenue', async () => {
    const analysis = await analyse({
      'p1.php': "<?php $a = 1; include 'h.php';",
      'p2.php': "<?php $b = 1; include 'h.php';",
      'p3.php': "<?php $c = 1; include 'h.php';",
      'h.php': '<?php echo $z;',
    }, { maxContexts: 1 });
    const report = analysis.report(uriOf('h.php'))!;
    assert.equal(report.approximate, true);
    assert.equal(report.reads[0].via.length, 3);
  });

  it('elseif après !isset, appel sous @ : pas d’alerte', async () => {
    const analysis = await analyse({ 'page.php': "<?php\nif (!isset($page)) { $page = 1; } elseif ($page < 1) { $page = 1; }\n@preg_match('/x/', 's', $m); echo $m;" });
    assert.deepEqual(reads(analysis, 'page.php'), []);
  });

  it('analyse coopérative : mêmes résultats, interruption possible', async () => {
    const files = {
      'lp_1/index.php': "<?php\n$title = 'A';\ninclude __DIR__.'/../header.php';",
      'lp_3/index.php': "<?php\ninclude __DIR__.'/../header.php';",
      'header.php': '<?php echo $title;',
    };
    const index = await project(files);
    const graph = new IncludeGraph(index, { roots: ['/p'], readFile: () => undefined });
    const lookup = new Lookup(index, new SymbolIndex());
    const cooperative = new IncludeAnalysis(index, lookup, graph, { maxContexts: 64, externalGlobals: [] });
    assert.equal(await cooperative.runAsync(() => false, 1), true);
    assert.deepEqual(reads(cooperative, 'header.php'), reads(await analyse(files), 'header.php'));
    let calls = 0;
    const stopped = new IncludeAnalysis(index, lookup, graph, { maxContexts: 64, externalGlobals: [] });
    assert.equal(await stopped.runAsync(() => ++calls > 1, 1), false);
  });

  it('symboles dans une fonction : vérifiés seulement si la chaîne appelle la fonction ; jamais dans les méthodes', async () => {
    const analysis = await analyse({
      'consts.php': "<?php define('CONST_A', 1); define('CONST_B', 2); define('CONST_C', 3);",
      'lib.php': '<?php function used() { return CONST_A; } function unused() { return CONST_B; } class K { function m() { return CONST_C; } }',
      'page.php': "<?php include 'lib.php'; used();",
    });
    assert.deepEqual(analysis.report(uriOf('lib.php'))!.symbols.map((s) => s.need.name), ['CONST_A']);
  });
  it('déclarations en double dans une chaîne d’inclusion', async () => {
    const analysis = await analyse({
      'a.php': '<?php function helper() {}',
      'b.php': '<?php function helper() {}',
      'guarded.php': "<?php if (!function_exists('helper')) { function helper() {} }",
      'twice.php': '<?php function once_only() {}',
      'page.php': "<?php\ninclude 'a.php';\ninclude 'b.php';\ninclude 'guarded.php';",
      'page2.php': "<?php\ninclude 'b.php';",
      'page3.php': "<?php\ninclude 'twice.php';\ninclude 'twice.php';\nrequire_once 'twice.php';",
    });
    assert.deepEqual(analysis.report(uriOf('b.php'))!.duplicates.map((d) => [d.name, d.other, d.via, d.others]), [['helper', uriOf('a.php'), [`${uriOf('page.php')}#2`], 1]]);
    assert.deepEqual(analysis.report(uriOf('guarded.php'))!.duplicates, []);
    assert.deepEqual(analysis.report(uriOf('page3.php'))!.duplicates.map((d) => [d.name, d.range.start.line]), [['twice.php', 2]]);
  });
});
