import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Diagnostic } from 'vscode-languageserver/node';
import { importAllMissing, importFixes } from '../src/server/imports/fixes.ts';
import { includeEdit, includeStatement } from '../src/server/imports/includeStyle.ts';
import { IncludeGraph } from '../src/server/includes/graph.ts';
import { Lookup } from '../src/server/index/lookup.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { extract, parse } from './helpers.ts';
import { project, uriOf } from './project.ts';

const diag = (line: number, start: number, end: number, code: string, data: unknown): Diagnostic => ({ range: { start: { line, character: start }, end: { line, character: end } }, code, message: code, data, source: 'PHP Forge' });

describe('style des includes', () => {
  it('constante comme ROOT_PATH, __DIR__, DOCUMENT_ROOT, relatif ; défaut __DIR__', async () => {
    const index = await project({ 'init.php': "<?php define('ROOT_PATH', $_SERVER['DOCUMENT_ROOT']);", 'includes/fonctions.php': '<?php' });
    const graph = new IncludeGraph(index, { roots: ['/p'], readFile: () => undefined });
    const style = async (rel: string, text: string) => includeStatement({ fsPath: `/p/${rel}`, text, symbols: await extract(text, uriOf(rel)) }, '/p/includes/fonctions.php', graph);
    assert.equal(await style('pages/a.php', "<?php\nrequire_once ROOT_PATH.'/includes/x.php';\n"), "require_once ROOT_PATH.'/includes/fonctions.php';");
    assert.equal(await style('pages/a.php', "<?php\ninclude __DIR__ . '/../includes/x.php';\n"), "include __DIR__ . '/../includes/fonctions.php';");
    assert.equal(await style('pages/a.php', "<?php\ninclude_once($_SERVER['DOCUMENT_ROOT'] . \"/includes/x.php\");\n"), "include_once($_SERVER['DOCUMENT_ROOT'] . \"/includes/fonctions.php\");");
    assert.equal(await style('pages/a.php', "<?php\nrequire 'x.php';\n"), "require '../includes/fonctions.php';");
    assert.equal(await style('pages/a.php', '<?php\necho 1;\n'), "require_once __DIR__ . '/../includes/fonctions.php';");
  });
});

describe('imports proposés', () => {
  it('classe d’un namespace : « Import Lib\\User » ; fonction sans namespace : « Add include »', async () => {
    const index = await project({
      'lib/User.php': '<?php\nnamespace Lib;\nclass User {}\n',
      'other/User.php': '<?php\nnamespace Other;\nclass User {}\n',
      'includes/fonctions.php': '<?php\nfunction format_date() {}\n',
    });
    const text = "<?php\nrequire_once __DIR__ . '/x.php';\nnew User();\nformat_date();\n";
    const symbols = await extract(text, uriOf('page.php'));
    index.set(symbols);
    const graph = new IncludeGraph(index, { roots: ['/p'], readFile: () => undefined });
    const env = { lookup: new Lookup(index, new SymbolIndex()), graph };
    const input = { uri: uriOf('page.php'), fsPath: '/p/page.php', text, tree: await parse(text), symbols };
    const diagnostics = [
      diag(2, 4, 8, 'undefined-class', { symbol: { kind: 'class', name: 'User' } }),
      diag(3, 0, 11, 'undefined-function', { symbol: { kind: 'function', name: 'format_date' } }),
    ];
    const actions = importFixes(input, diagnostics, env);
    assert.deepEqual(actions.map((a) => a.title), ['Import Lib\\User', 'Import Other\\User', "Add include 'includes/fonctions.php'"]);
    assert.deepEqual(actions[2].edit?.changes?.[uriOf('page.php')], [{ range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } }, newText: "require_once __DIR__ . '/includes/fonctions.php';\n" }]);
    assert.equal(importAllMissing(input, diagnostics, env), undefined);
  });

  it('symbole non inclus : « Add include » du fichier qui le déclare ; « Import all missing » quand chaque nom a un seul candidat', async () => {
    const index = await project({ 'lib/A.php': '<?php\nnamespace Lib;\nclass A {}\n', 'lib/B.php': '<?php\nnamespace Lib;\nclass B {}\n' });
    const text = '<?php\nnamespace App;\n\nnew A();\nnew B();\nhelper();\n';
    const symbols = await extract(text, uriOf('app.php'));
    const env = { lookup: new Lookup(index, new SymbolIndex()) };
    const input = { uri: uriOf('app.php'), fsPath: '/p/app.php', text, tree: await parse(text), symbols };
    const diagnostics = [
      diag(3, 4, 5, 'undefined-class', { symbol: { kind: 'class', name: 'A' } }),
      diag(4, 4, 5, 'undefined-class', { symbol: { kind: 'class', name: 'B' } }),
      diag(5, 0, 6, 'symbol-not-included', { declaredIn: [uriOf('includes/helpers.php')] }),
    ];
    const all = importAllMissing(input, diagnostics, env)!;
    assert.equal(all.title, 'Import all missing classes');
    assert.deepEqual(all.edit?.changes?.[uriOf('app.php')].map((e) => e.newText), ['use Lib\\A;\nuse Lib\\B;\n\n']);
    assert.deepEqual(importFixes(input, [diagnostics[2]], env).map((a) => a.title), ["Add include 'includes/helpers.php'"]);
  });

  it('Add include : avant l’utilisation, après declare, jamais dans le HTML', async () => {
    const edit = async (text: string, before: number) => includeEdit(await parse(text), text, "require 'x.php';", before);
    assert.equal((await edit("<?php\nrequire 'header.php';\nformat_date();\nrequire 'footer.php';\n", 2))?.range.start.line, 2);
    assert.equal((await edit('<?php\ndeclare(strict_types=1);\nformat_date();\n', 2))?.range.start.line, 2);
    assert.equal(await edit("<?php require 'a.php'; ?>\n<html><?php f(); ?>\n", 1), undefined);
    assert.equal(await edit('<p><?php f(); ?></p>\n', 0), undefined);
  });
});
