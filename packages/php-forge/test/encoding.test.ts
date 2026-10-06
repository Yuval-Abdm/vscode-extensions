import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decode } from '../src/server/parser/encoding.ts';

test('UTF-8 valide', () => assert.equal(decode(Buffer.from('é€', 'utf8')), 'é€'));

test('Windows-1252 si le UTF-8 est invalide (fichiers Latin-1)', () => {
  assert.equal(decode(Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80])), 'café €');
});

test('BOM UTF-8 retiré', () => assert.equal(decode(Uint8Array.from([0xef, 0xbb, 0xbf, 0x3c])), '<'));
