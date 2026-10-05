import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IncludeGraph } from '../src/server/includes/graph.ts';
import { project, uriOf } from './project.ts';

const noFiles = () => undefined;

describe('graphe d’inclusion', () => {
  it('cibles, appelants, constantes, scripts d’entrée, gabarits dynamiques', async () => {
    const index = await project({
      'rp_appInit.php': "<?php define('ROOT_PATH', $_SERVER['DOCUMENT_ROOT']); include ROOT_PATH.'/inc/db.php';",
      'inc/db.php': "<?php include 'helpers.php';",
      'inc/helpers.php': '<?php',
      'pages/a.php': "<?php include $_SERVER['DOCUMENT_ROOT'].'/rp_appInit.php'; include ROOT_PATH.'/templates/'.$p.'.php'; include 'nope.php';",
      'templates/home.php': '<?php echo $x;',
    });
    const graph = new IncludeGraph(index, { roots: ['/p'], readFile: noFiles });
    assert.equal(graph.constant('ROOT_PATH'), '/p');
    assert.equal(graph.sitesOf(uriOf('rp_appInit.php'))[0].target, uriOf('inc/db.php'));
    assert.equal(graph.sitesOf(uriOf('inc/db.php'))[0].target, uriOf('inc/helpers.php'));
    assert.deepEqual(graph.includersOf(uriOf('rp_appInit.php')).map((s) => [s.from, s.line]), [[uriOf('pages/a.php'), 0]]);
    assert.deepEqual(graph.entries().sort(), [uriOf('pages/a.php'), uriOf('templates/home.php')].sort());
    assert.equal(graph.files().length, 5);
    assert.equal(graph.isDynamicTarget(uriOf('templates/home.php')), true);
    assert.equal(graph.isDynamicTarget(uriOf('pages/a.php')), false);
    const [, dynamic, missing] = graph.sitesOf(uriOf('pages/a.php'));
    assert.deepEqual([dynamic.evaluated, dynamic.target], [false, undefined]);
    assert.deepEqual([missing.evaluated, missing.target], [true, undefined]);
  });

  it('documentRoot, serverRoot, deploy.json, composer', async () => {
    const index = await project({
      'x.php': "<?php include '/home/site/www/inc/y.php'; include '/srv/app/inc/y.php';",
      'inc/y.php': '<?php',
      'src/A.php': '<?php class A {}',
      'lib/fns.php': '<?php function fns() {}',
      'vendor/acme/B.php': '<?php class B {}',
    });
    const files: Record<string, string> = {
      '/p/.vscode/deploy.json': '{\n  // profils\n  "profiles": { "prod": { "host": "h", "remotePath": "/home/site/www", }, },\n}',
      '/p/composer.json': JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'src/' }, files: ['lib/fns.php'] } }),
    };
    const graph = new IncludeGraph(index, { roots: ['/p'], serverRoot: '/srv/app', readFile: (p) => files[p] });
    assert.deepEqual(graph.sitesOf(uriOf('x.php')).map((s) => s.target), [uriOf('inc/y.php'), uriOf('inc/y.php')]);
    assert.equal(graph.isAutoloaded(uriOf('src/A.php')), true);
    assert.equal(graph.isAutoloaded(uriOf('vendor/acme/B.php')), true);
    assert.equal(graph.isAutoloaded(uriOf('x.php')), false);
    assert.equal(graph.alwaysLoaded.has(uriOf('lib/fns.php')), true);
    assert.equal(new IncludeGraph(index, { roots: ['/p'], documentRoot: 'public', readFile: noFiles }).docroot, '/p/public');
  });

  it('constante définie différemment selon les fichiers : inconnue hors chaîne d’appel', async () => {
    const index = await project({
      'a.php': "<?php define('BASE', '/p/a');",
      'b.php': "<?php define('BASE', '/p/b');",
      'c.php': "<?php define('LIB', __DIR__ . '/lib'); define('SUB', LIB . '/sub');",
    });
    const graph = new IncludeGraph(index, { roots: ['/p'], readFile: noFiles });
    assert.equal(graph.constant('BASE'), undefined);
    assert.equal(graph.constant('SUB'), '/p/lib/sub');
  });

  it('include dynamique à la racine (routeur) : la racine n’est pas un dossier de gabarits', async () => {
    const index = await project({
      'index.php': "<?php include $_SERVER['DOCUMENT_ROOT'] . '/' . $page . '.php'; include __DIR__ . '/' . $m . '.php';",
      'pages/a.php': '<?php echo $x;',
      'other.php': '<?php',
    });
    const graph = new IncludeGraph(index, { roots: ['/p'], readFile: noFiles });
    assert.equal(graph.isDynamicTarget(uriOf('pages/a.php')), false);
    assert.equal(graph.isDynamicTarget(uriOf('other.php')), false);
  });
});
