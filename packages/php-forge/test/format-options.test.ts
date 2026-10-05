import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_FORMAT, formatText, type FormatOptions } from '../src/server/format/format.ts';
import { parse } from './helpers.ts';

async function fmt(code: string, options: Partial<FormatOptions>): Promise<string> {
  const opts = { ...DEFAULT_FORMAT, ...options };
  const out = formatText(await parse(code), code, opts);
  assert.equal(formatText(await parse(out), out, opts), out, 'non idempotent');
  return out;
}

describe('options du formateur', () => {
  it('alignement des => d’un tableau et des = consécutifs', async () => {
    const code = '<?php\n$a = [\n"k" => 1,\n"long" => 2,\n"x"=>[\n1\n]\n];\n$x = 1;\n$longer = 2;\nfoo();\n$b = 3;\n';
    assert.equal(await fmt(code, { alignArrows: true, alignAssignments: true }), '<?php\n$a = [\n    "k"    => 1,\n    "long" => 2,\n    "x"    => [\n        1\n    ]\n];\n$x      = 1;\n$longer = 2;\nfoo();\n$b = 3;\n');
  });

  it('pas d’alignement au-delà de la longueur de ligne', async () => {
    const code = '<?php\n$a = [\n"k" => 1,\n"very_long_key_name" => 2,\n];\n';
    assert.equal(await fmt(code, { alignArrows: true, lineLength: 20 }), '<?php\n$a = [\n    "k" => 1,\n    "very_long_key_name" => 2,\n];\n');
  });

  it('virgule finale des tableaux sur plusieurs lignes', async () => {
    const code = '<?php\n$a = [\n1,\n2\n];\n$b = array(\n"x"\n);\n$c = [1, 2];\n';
    assert.equal(await fmt(code, { trailingCommas: true }), '<?php\n$a = [\n    1,\n    2,\n];\n$b = array(\n    "x",\n);\n$c = [1, 2];\n');
  });
});
