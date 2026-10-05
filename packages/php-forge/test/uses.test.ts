import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TextEdit } from 'vscode-languageserver/node';
import { addUse, organizeUses, useConflict } from '../src/server/imports/uses.ts';
import { parse } from './helpers.ts';

function apply(text: string, edits: TextEdit[]): string {
  const lines = text.split('\n');
  const offset = (p: { line: number; character: number }) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  let out = text;
  for (const e of [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start))) out = out.slice(0, offset(e.range.start)) + e.newText + out.slice(offset(e.range.end));
  return out;
}

async function add(text: string, fqn: string, kind: 'class' | 'function' | 'const' = 'class') {
  const edit = addUse(await parse(text), text, fqn, kind);
  return edit ? apply(text, [edit]) : undefined;
}

describe('ajout d’un use', () => {
  it('trié parmi les use existants', async () => {
    assert.equal(await add('<?php\nnamespace App;\n\nuse Lib\\A;\nuse Lib\\C;\n\nnew A();\n', 'Lib\\B'), '<?php\nnamespace App;\n\nuse Lib\\A;\nuse Lib\\B;\nuse Lib\\C;\n\nnew A();\n');
    assert.equal(await add('<?php\nnamespace App;\n\nuse Lib\\A;\n\nnew A();\n', 'Zed\\Z'), '<?php\nnamespace App;\n\nuse Lib\\A;\nuse Zed\\Z;\n\nnew A();\n');
  });

  it('premier use : après le namespace, sinon après <?php', async () => {
    assert.equal(await add('<?php\nnamespace App;\n\nclass A {}\n', 'Lib\\User'), '<?php\nnamespace App;\n\nuse Lib\\User;\n\nclass A {}\n');
    assert.equal(await add('<?php\n$u = 1;\n', 'Lib\\User'), '<?php\nuse Lib\\User;\n\n$u = 1;\n');
  });

  it('use function / use const ; déjà importé ; conflit de nom court', async () => {
    assert.equal(await add('<?php\nnamespace App;\n\nuse Lib\\A;\n', 'Lib\\helper', 'function'), '<?php\nnamespace App;\n\nuse Lib\\A;\nuse function Lib\\helper;\n');
    assert.equal(await add('<?php\nuse Lib\\A;\n', 'Lib\\A'), undefined);
    const tree = await parse('<?php\nuse Lib\\User;\n');
    assert.equal(useConflict(tree, 'Other\\User', 'class'), true);
    assert.equal(useConflict(tree, 'Lib\\User', 'class'), false);
  });
});

describe('organiser les use', () => {
  it('trier, regrouper par sorte, retirer les inutilisés, déplier les groupes', async () => {
    const text = '<?php\nnamespace App;\n\nuse function Lib\\helper;\nuse Lib\\{Zed, Alpha};\nuse Lib\\Unused;\nuse const Lib\\MAX;\n\nnew Zed(); new Alpha(); helper(); echo MAX;\n';
    assert.equal(apply(text, organizeUses(await parse(text), text)), '<?php\nnamespace App;\n\nuse Lib\\Alpha;\nuse Lib\\Zed;\n\nuse function Lib\\helper;\n\nuse const Lib\\MAX;\n\nnew Zed(); new Alpha(); helper(); echo MAX;\n');
  });

  it('commentaire au milieu des use, ou rien à changer : aucune modification', async () => {
    const commented = '<?php\nuse B\\Y;\n// garde\nuse A\\X;\nnew X(); new Y();\n';
    assert.deepEqual(organizeUses(await parse(commented), commented), []);
    const clean = '<?php\nuse A\\X;\n\nnew X();\n';
    assert.deepEqual(organizeUses(await parse(clean), clean), []);
  });
});
