import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { loadStubs, STUBS_FORMAT, STUBS_TAG, stubExtension } from '../src/server/stubs/stubs.ts';
import { extract } from './helpers.ts';

const generated = path.join(import.meta.dirname, '..', 'dist', 'stubs.json.gz');

describe('stubs', () => {
  it('charge un index généré', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'php-forge-stubs-')), 'stubs.json.gz');
    const symbols = await extract('<?php /** Longueur */ function strlen(string $string): int {}', 'phpstub:/standard/basic.php');
    writeFileSync(file, gzipSync(JSON.stringify({ format: STUBS_FORMAT, tag: STUBS_TAG, files: [symbols] })));
    assert.equal(loadStubs(file).findFunction('strlen')[0].symbol.doc, 'Longueur');
  });

  it("fichier absent ou d'un autre format : index vide", () => {
    assert.equal(loadStubs('/nulle/part/stubs.json.gz').size, 0);
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'php-forge-stubs-')), 'stubs.json.gz');
    writeFileSync(file, gzipSync(JSON.stringify({ format: STUBS_FORMAT + 1, files: [] })));
    assert.equal(loadStubs(file).size, 0);
  });

  it("extension PHP d'un stub", () => assert.equal(stubExtension('phpstub:/mysqli/mysqli.php'), 'mysqli'));

  it('stubs générés : fonctions, classes, versions', { skip: !existsSync(generated) }, () => {
    const index = loadStubs(generated);
    assert.ok(index.findFunction('strlen').length);
    assert.ok(index.findClass('PDO').length);
    assert.ok(index.findFunction('mysql_query').length);
  });
});
