import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DocumentStore } from '../src/server/documents.ts';
import { extract, parser } from './helpers.ts';

describe('résumés : noms utilisés, remplacements', () => {
  it('identifiants utilisés par le fichier (minuscules, triés, uniques)', async () => {
    const file = await extract('<?php\nnamespace App;\nuse Lib\\User;\n$u = new User();\n$u->Save();\necho MAX, strlen("x");\n');
    assert.deepEqual(file.names, ['app', 'lib', 'max', 'save', 'strlen', 'u', 'user']);
  });

  it('modèle de remplacement d’une fonction dépréciée (attribut des stubs)', async () => {
    const file = await extract("<?php\n#[Deprecated(replacement: 'nl2br(hebrev(%parameter0%))', since: '7.4')]\nfunction hebrevc($t) {}\n");
    assert.equal(file.symbols[0].replacement, 'nl2br(hebrev(%parameter0%))');
  });

  it('pendant la frappe : noms précédents gardés, recalculés à la pause', async () => {
    const store = new DocumentStore(await parser());
    store.open('file:///t.php', 'php', 1, '<?php\nalpha();\n');
    const changed = store.change('file:///t.php', 2, [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, text: 'beta();\n' }])!;
    assert.deepEqual(changed.symbols.names, ['alpha']);
    assert.deepEqual(store.inferTypes('file:///t.php')!.symbols.names, ['alpha', 'beta']);
  });
});
