import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CompletionItemKind } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { sqlCompletionList, sqlDefinitionAt, sqlHoverAt } from '../src/server/sql/lsp.ts';
import { parseSqlFile, Schema } from '../src/server/sql/schema.ts';
import { cursor, parse } from './helpers.ts';

const SQL_URI = 'file:///p/sql/schema.sql';

function schema(): Schema {
  const s = new Schema();
  s.add(parseSqlFile('CREATE TABLE clients (\n  id int(11) NOT NULL,\n  nom varchar(100) DEFAULT NULL\n);\n', SQL_URI));
  s.addCache({ database: 'crm', refreshed: '', tables: [{ name: 'contrats', columns: [{ name: 'montant', type: 'decimal(10,2)', nullable: true }] }] }, 'file:///p/.vscode/php-forge-schema.json');
  return s;
}

async function at(code: string) {
  const { text, position } = cursor(code);
  return { tree: await parse(text), doc: TextDocument.create('file:///p/a.php', 'php', 1, text), position };
}

describe('SQL au format LSP', () => {
  it('complétion des colonnes d’un alias : remplace le mot commencé', async () => {
    const { tree, doc, position } = await at('<?php\n$q = "SELECT c.n| FROM clients c";\n');
    const list = sqlCompletionList(tree, doc, position, schema())!;
    assert.deepEqual(list.items.map((i) => i.label), ['id', 'nom']);
    assert.equal(list.items[1].kind, CompletionItemKind.Field);
    assert.deepEqual((list.items[1].textEdit as { range: unknown }).range, { start: { line: 1, character: 15 }, end: position });
  });

  it('hors d’une requête : undefined (complétion PHP)', async () => {
    const { tree, doc, position } = await at('<?php\n$a = $b.|;\n');
    assert.equal(sqlCompletionList(tree, doc, position, schema()), undefined);
  });

  it('survol d’une colonne ; définition vers le CREATE TABLE, jamais vers le cache', async () => {
    const hover = await at('<?php\n$q = "SELECT n|om FROM clients";\n');
    assert.match(String((sqlHoverAt(hover.tree, hover.doc, hover.position, schema())!.contents as { value: string }).value), /varchar\(100\)/);
    const def = await at('<?php\n$q = "SELECT nom FROM cli|ents";\n');
    assert.deepEqual(sqlDefinitionAt(def.tree, def.doc, def.position, schema()), [{ uri: SQL_URI, range: { start: { line: 0, character: 13 }, end: { line: 0, character: 20 } } }]);
    const cached = await at('<?php\n$q = "SELECT * FROM contr|ats";\n');
    assert.equal(sqlDefinitionAt(cached.tree, cached.doc, cached.position, schema()), undefined);
  });
});
