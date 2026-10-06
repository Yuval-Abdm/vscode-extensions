import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { unquotePath } from '../src/git/parsers/paths.ts';

describe('unquotePath', () => {
  it('chemin sans guillemets : inchangé', () => {
    assert.equal(unquotePath('dossier é/a b.txt'), 'dossier é/a b.txt');
  });

  it('échappements C et octets en octal', () => {
    assert.equal(unquotePath('"a\\tb\\"c\\\\d.txt"'), 'a\tb"c\\d.txt');
    assert.equal(unquotePath('"\\303\\251t\\303\\251.txt"'), 'été.txt');
  });
});
