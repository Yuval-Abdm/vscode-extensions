import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extract } from './helpers.ts';

describe('déclarations : informations pour les diagnostics', () => {
  it('version de dépréciation : @deprecated et attribut Deprecated', async () => {
    const file = await extract("<?php\n/** @deprecated 8.4 */\nfunction a() {}\n#[Deprecated(reason: 'x', since: '7.4')]\nfunction b() {}\n/** @deprecated */\nfunction c() {}\n");
    assert.deepEqual(file.symbols.map((s) => [s.name, s.deprecated, s.deprecatedSince]), [['a', true, '8.4'], ['b', true, '7.4'], ['c', true, undefined]]);
  });

  it('version de dépréciation après un remplacement qui contient des parenthèses', async () => {
    const file = await extract(`<?php\n#[Deprecated(replacement: "mb_convert_encoding(%parameter0%, 'UTF-8', 'ISO-8859-1')", since: "8.2")]\nfunction utf8_encode(string $s): string {}\n`);
    assert.equal(file.symbols[0].deprecatedSince, '8.2');
  });

  it('déclarations conditionnelles', async () => {
    const file = await extract("<?php\nfunction top() {}\nif (!function_exists('f')) { function f() {} }\nfunction outer() { function inner() {} }\nnamespace App { function spaced() {} class K {} }\n");
    assert.deepEqual(file.symbols.map((s) => [s.name, s.conditional]), [['top', undefined], ['f', true], ['outer', undefined], ['inner', true], ['spaced', undefined], ['K', undefined]]);
  });

  it('propriétés créées par $this->x = … sans déclaration', async () => {
    const file = await extract('<?php\nclass A {\n  public $declared;\n  function __construct() { $this->declared = 1; $this->made = new B(); $this->other[] = 2; }\n}\n');
    const props = file.symbols[0].children!.filter((c) => c.kind === 'property');
    assert.deepEqual(props.map((p) => [p.name, p.dynamic]), [['declared', undefined], ['made', true], ['other', true]]);
    assert.deepEqual(props[1].inferred, { kind: 'class', fqn: 'B' });
  });

  it('fonctions qui lisent leurs arguments avec func_get_args', async () => {
    const file = await extract('<?php\nfunction v() { return func_get_args(); }\nfunction n($a) { return $a; }\nclass C { function m() { return func_num_args(); } }\n');
    assert.deepEqual([file.symbols[0].variadicBody, file.symbols[1].variadicBody, file.symbols[2].children![0].variadicBody], [true, undefined, true]);
  });
});
