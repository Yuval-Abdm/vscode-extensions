import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { complete } from '../src/server/completion/complete.ts';
import { DocumentStore } from '../src/server/documents.ts';
import { Lookup } from '../src/server/index/lookup.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { TypeResolver } from '../src/server/types/expand.ts';
import { extract, parser } from './helpers.ts';

async function items(code: string, line: number, character: number, autoImport = true) {
  const workspace = new SymbolIndex();
  workspace.set(await extract('<?php\nnamespace Lib;\nclass User {}\nfunction helper() {}\n', 'file:///p/lib.php'));
  workspace.set(await extract('<?php\nnamespace Other;\nclass User {}\n', 'file:///p/other.php'));
  const store = new DocumentStore(await parser());
  const doc = store.open('file:///p/page.php', 'php', 1, code);
  workspace.set(doc.symbols);
  const resolver = new TypeResolver(new Lookup(workspace, new SymbolIndex()), '8.3');
  return complete({ resolver, parser: await parser(), folders: [], autoImport }, doc, { line, character })!.items;
}

describe('import automatique', () => {
  it('classe d’un autre namespace : nom court et use ajouté', async () => {
    const list = await items('<?php\nnamespace App;\n\nnew Use\n', 3, 7);
    const user = list.find((i) => i.label === 'User' && i.labelDetails?.description === 'Lib')!;
    assert.equal((user.textEdit as { newText: string }).newText, 'User');
    assert.deepEqual(user.additionalTextEdits, [{ range: { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } }, newText: 'use Lib\\User;\n\n' }]);
  });

  it('nom court déjà importé pour une autre classe : nom complet, pas de use', async () => {
    const list = await items('<?php\nnamespace App;\n\nuse Other\\User;\n\nnew Use\n', 5, 7);
    const user = list.find((i) => i.label === 'User' && i.labelDetails?.description === 'Lib')!;
    assert.equal((user.textEdit as { newText: string }).newText, '\\Lib\\User');
    assert.equal(user.additionalTextEdits, undefined);
  });

  it('classe déjà accessible : rien à ajouter ; fonction d’un namespace : use function', async () => {
    const list = await items('<?php\nnamespace App;\n\nuse Other\\User;\n\nnew Use\n', 5, 7);
    const other = list.find((i) => i.label === 'User' && i.labelDetails?.description === 'Other')!;
    assert.equal(other.additionalTextEdits, undefined);
    const fn = (await items('<?php\nnamespace App;\n\nhelp\n', 3, 4)).find((i) => i.label === 'helper')!;
    assert.deepEqual(fn.additionalTextEdits?.[0].newText, 'use function Lib\\helper;\n\n');
  });

  it('import automatique désactivé : nom complet', async () => {
    const user = (await items('<?php\nnamespace App;\n\nnew Use\n', 3, 7, false)).find((i) => i.label === 'User' && i.labelDetails?.description === 'Lib')!;
    assert.equal((user.textEdit as { newText: string }).newText, '\\Lib\\User');
    assert.equal(user.additionalTextEdits, undefined);
  });
});
