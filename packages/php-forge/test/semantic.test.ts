import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { semanticTokens, TOKEN_MODIFIERS, TOKEN_TYPES } from '../src/server/features/semanticTokens.ts';
import { Lookup } from '../src/server/index/lookup.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { extractFile } from '../src/server/model/extract.ts';
import { extract, parse } from './helpers.ts';

const CODE = [
  '<?php',
  'namespace App;',
  'use Lib\\Base;',
  '/** @deprecated */',
  'function old() {}',
  'class Shop extends Base {',
  '  const LIMIT = 1;',
  "  public static function make(int $qty) { old(); strlen('x'); return static::LIMIT + $qty; }",
  "  public function find($id) { return rp_query('SELECT COUNT(*) FROM t WHERE id = '.$id.' LIMIT 1'); }",
  '}',
].join('\n');

async function tokens() {
  const tree = await parse(CODE);
  const file = extractFile(tree, 'file:///shop.php');
  const workspace = new SymbolIndex();
  workspace.set(file);
  const stubs = new SymbolIndex();
  stubs.set(await extract('<?php function strlen(string $string): int {}', 'phpstub:/standard/s.php'));
  const data = semanticTokens(new Lookup(workspace, stubs), file, tree);
  const lines = CODE.split('\n');
  const out: { line: number; text: string; type: string; modifiers: string[] }[] = [];
  let line = 0;
  let character = 0;
  for (let i = 0; i < data.length; i += 5) {
    line += data[i];
    character = data[i] === 0 ? character + data[i + 1] : data[i + 1];
    const modifiers = TOKEN_MODIFIERS.filter((_, bit) => data[i + 4] & (1 << bit)).sort();
    out.push({ line, text: lines[line].slice(character, character + data[i + 2]), type: TOKEN_TYPES[data[i + 3]], modifiers });
  }
  return out;
}

describe('tokens sémantiques', async () => {
  const all = await tokens();
  const find = (line: number, text: string, nth = 0) => {
    const token = all.filter((t) => t.line === line && t.text === text)[nth];
    return token && { type: token.type, modifiers: token.modifiers };
  };

  it('namespaces et classes', () => {
    assert.deepEqual(find(1, 'App'), { type: 'namespace', modifiers: [] });
    assert.deepEqual(find(2, 'Lib'), { type: 'namespace', modifiers: [] });
    assert.deepEqual(find(5, 'Shop'), { type: 'class', modifiers: ['declaration'] });
    assert.deepEqual(find(5, 'Base'), { type: 'class', modifiers: [] });
  });

  it('fonctions : déclaration, obsolescence, bibliothèque native', () => {
    assert.deepEqual(find(4, 'old'), { type: 'function', modifiers: ['declaration', 'deprecated'] });
    assert.deepEqual(find(7, 'old'), { type: 'function', modifiers: ['deprecated'] });
    assert.deepEqual(find(7, 'strlen'), { type: 'function', modifiers: ['defaultLibrary'] });
  });

  it('méthodes, constantes de classe, paramètres', () => {
    assert.deepEqual(find(7, 'make'), { type: 'method', modifiers: ['declaration', 'static'] });
    assert.deepEqual(find(6, 'LIMIT'), { type: 'property', modifiers: ['declaration', 'readonly', 'static'] });
    assert.deepEqual(find(7, 'LIMIT'), { type: 'property', modifiers: ['readonly', 'static'] });
    assert.deepEqual(find(7, '$qty', 0), { type: 'parameter', modifiers: ['declaration'] });
    assert.deepEqual(find(7, '$qty', 1), { type: 'parameter', modifiers: [] });
  });

  it('SQL dans les chaînes : mots-clés, fonctions, nombres, autour des autres jetons', () => {
    assert.deepEqual(find(8, 'SELECT'), { type: 'keyword', modifiers: [] });
    assert.deepEqual(find(8, 'COUNT'), { type: 'function', modifiers: [] });
    assert.deepEqual(find(8, 'LIMIT'), { type: 'keyword', modifiers: [] });
    assert.deepEqual(find(8, '1'), { type: 'number', modifiers: [] });
    assert.deepEqual(find(8, '$id', 1), { type: 'parameter', modifiers: [] });
  });
});
