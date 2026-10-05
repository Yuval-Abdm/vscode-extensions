import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { quickFixes } from '../src/server/features/codeActions.ts';
import { braceOffsetLines, deprecatedSyntax } from '../src/server/diagnostics/deprecatedSyntax.ts';
import { parse } from './helpers.ts';

async function check(code: string, version: string) {
  return deprecatedSyntax(await parse(code), code, version);
}

function apply(code: string, diagnostic: Parameters<typeof quickFixes>[1][number]): string {
  const [fix] = quickFixes('file:///a.php', [diagnostic]);
  const lines = code.split('\n');
  const offset = (p: { line: number; character: number }) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  let text = code;
  for (const e of [...(fix.edit!.changes!['file:///a.php'])].sort((a, b) => offset(b.range.start) - offset(a.range.start))) {
    text = text.slice(0, offset(e.range.start)) + e.newText + text.slice(offset(e.range.end));
  }
  return text;
}

describe('syntaxe dépréciée', () => {
  it('offset entre accolades : message clair et correction', async () => {
    const code = '<?php\necho $s{0};\n';
    const [d] = await check(code, '7.4');
    assert.equal(d.code, 'deprecated-syntax');
    assert.match(String(d.message), /\$s\[0\]/);
    assert.equal(apply(code, d), '<?php\necho $s[0];\n');
    assert.deepEqual([...braceOffsetLines([d])], [1]);
    assert.match(String((await check(code, '8.1'))[0].message), /removed in PHP 8\.0/);
    assert.deepEqual(await check(code, '7.3'), []);
  });

  it('casts (real) et (unset)', async () => {
    const code = '<?php\n$a = (real)$x;\n$b = (unset)$y;\n$c = (float)$z;\n';
    const diagnostics = await check(code, '7.4');
    assert.deepEqual(diagnostics.map((d) => d.range.start.line), [1, 2]);
    assert.equal(apply(code, diagnostics[0]), '<?php\n$a = (float)$x;\n$b = (unset)$y;\n$c = (float)$z;\n');
    assert.deepEqual((await check(code, '7.1')).length, 0);
  });

  it('ternaires imbriqués sans parenthèses', async () => {
    const diagnostics = await check('<?php\necho $a ? 1 : $b ? 2 : 3;\necho $a ? 1 : ($b ? 2 : 3);\n', '7.4');
    assert.deepEqual(diagnostics.map((d) => d.range.start.line), [1]);
  });

  it('${var} dans une chaîne (8.2)', async () => {
    const code = '<?php\necho "${var} et ${tab[\'k\']} et {$ok}";\n';
    const diagnostics = await check(code, '8.2');
    assert.equal(diagnostics.length, 2);
    assert.equal(apply(code, diagnostics[0]), '<?php\necho "{$var} et ${tab[\'k\']} et {$ok}";\n');
    assert.equal(apply(code, diagnostics[1]), '<?php\necho "${var} et {$tab[\'k\']} et {$ok}";\n');
    assert.deepEqual(await check(code, '8.1'), []);
  });

  it('paramètre implicitement nullable (8.4)', async () => {
    const code = '<?php\nfunction f(Foo $x = null, ?Bar $y = null, $z = null, int|string $u = null) {}\n';
    const diagnostics = await check(code, '8.4');
    assert.deepEqual(diagnostics.length, 2);
    assert.equal(apply(code, diagnostics[0]), '<?php\nfunction f(?Foo $x = null, ?Bar $y = null, $z = null, int|string $u = null) {}\n');
    assert.deepEqual(await check(code, '8.3'), []);
  });

  it('constructeur PHP 4', async () => {
    assert.deepEqual((await check('<?php\nclass Old { function Old() {} }\n', '7.0')).map((d) => d.range.start.line), [1]);
    assert.deepEqual(await check('<?php\nclass New_ { function __construct() {} function New_() {} }\nnamespace A { class B { function B() {} } }\n', '7.0'), []);
  });
});
