import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DiagnosticSeverity, DiagnosticTag } from 'vscode-languageserver/node';
import { codeDiagnostics } from '../src/server/diagnostics/code.ts';
import { parse } from './helpers.ts';

async function check(code: string) {
  return codeDiagnostics(await parse(code)).map((d) => {
    const lines = code.split('\n');
    const text = d.range.start.line === d.range.end.line
      ? lines[d.range.start.line].slice(d.range.start.character, d.range.end.character)
      : `${lines[d.range.start.line].slice(d.range.start.character)}…`;
    return `${d.code} ${text}`;
  });
}

describe('use inutilisés', () => {
  it('classe, alias, fonction, constante, groupe', async () => {
    const code = [
      '<?php',
      'namespace App;',
      'use Lib\\Used;',
      'use Lib\\Unused;',
      'use Lib\\Other as Alias;',
      'use Lib\\{InGroup, NotInGroup};',
      'use function Lib\\helper;',
      'use function Lib\\unusedHelper;',
      'use const Lib\\LIMIT;',
      'use Lib\\InDoc;',
      'new Used(); Alias::run(); new InGroup(); helper(); echo LIMIT;',
      '/** @var InDoc $x */',
    ].join('\n');
    assert.deepEqual(await check(code), [
      'unused-use Lib\\Unused',
      'unused-use NotInGroup',
      'unused-use Lib\\unusedHelper',
    ]);
  });

  it('niveau indice, texte grisé', async () => {
    const [d] = codeDiagnostics(await parse('<?php\nuse A\\B;\n'));
    assert.deepEqual([d.severity, d.tags], [DiagnosticSeverity.Hint, [DiagnosticTag.Unnecessary]]);
    assert.equal(d.message, 'Unused use statement: A\\B');
  });
});

describe('code inatteignable', () => {
  it('après return, throw, exit, die, break, continue', async () => {
    const code = [
      '<?php',
      'function f() {',
      '  return 1;',
      '  echo "a";',
      '  echo "b";',
      '}',
      'function g() { throw new E(); $x = 1; }',
      'while (true) { break; echo 1; }',
      'if ($a) { exit; echo 2; }',
      'if ($b) { die("x"); echo 3; }',
      'switch ($c) { case 1: return; echo 4; case 2: echo 5; }',
    ].join('\n');
    assert.deepEqual(await check(code), [
      'unreachable-code echo "a";…',
      'unreachable-code $x = 1;',
      'unreachable-code echo 1;',
      'unreachable-code echo 2;',
      'unreachable-code echo 3;',
      'unreachable-code echo 4;',
    ]);
  });

  it('déclarations de fonctions et de classes, HTML, étiquettes de goto : pas inatteignables', async () => {
    assert.deepEqual(await check('<?php\nreturn;\nfunction later() {}\nclass Later {}\n?>\n<p>html</p>\n'), []);
    assert.deepEqual(await check('<?php\ngoto end;\necho 1;\nend:\necho 2;\n'), ['unreachable-code echo 1;']);
  });
});
