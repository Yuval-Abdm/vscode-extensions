import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { complete } from '../src/server/completion/complete.ts';
import { DocumentStore } from '../src/server/documents.ts';
import { definition } from '../src/server/features/definition.ts';
import { hover } from '../src/server/features/hover.ts';
import { Lookup } from '../src/server/index/lookup.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { TypeResolver } from '../src/server/types/expand.ts';
import { registerExternal, type ExternalVariables } from '../src/server/types/external.ts';
import { extract, parser } from './helpers.ts';

const PDO_STUB = '<?php class PDO { /** @return PDOStatement */ public function query(string $q) {} }';
const DB = 'file:///p/includes/db.php';
const provider: ExternalVariables = {
  variable: (name) => (name === 'pdo' ? { type: { kind: 'class', fqn: 'PDO' }, origin: { uri: DB, line: 1, label: 'includes/db.php:2' } } : name === 'nom' ? { request: { from: '$_POST', line: 0 } } : undefined),
  names: () => ['pdo', 'site'],
};

async function setup(code: string) {
  const store = new DocumentStore(await parser());
  const doc = store.open('file:///p/page.php', 'php', 1, code);
  registerExternal(doc.symbols.scopes, provider);
  const stubs = new SymbolIndex();
  stubs.set(await extract(PDO_STUB, 'phpstub:/PDO/PDO.php'));
  const lookup = new Lookup(new SymbolIndex(), stubs);
  return { doc, lookup, resolver: new TypeResolver(lookup) };
}

describe('variables venues d’autres fichiers', () => {
  it('survol : type et fichier d’origine', async () => {
    const { doc, lookup, resolver } = await setup("<?php\n$pdo->query('x');\n");
    const value = (hover(lookup, doc.symbols, doc.tree, { line: 1, character: 2 }, resolver)?.contents as { value: string }).value;
    assert.match(value, /PDO \$pdo/);
    assert.match(value, /Defined in \[includes\/db\.php:2\]\(file:\/\/\/p\/includes\/db\.php#L2\)/);
  });

  it('survol : variable venue de la requête par extract', async () => {
    const { doc, lookup, resolver } = await setup('<?php\necho $nom;\n');
    const value = (hover(lookup, doc.symbols, doc.tree, { line: 1, character: 7 }, resolver)?.contents as { value: string }).value;
    assert.match(value, /From \$_POST via extract \(line 1\)/);
  });

  it('membres selon le type venu d’un autre fichier', async () => {
    const { doc, resolver } = await setup('<?php\n$pdo->\n');
    const list = complete({ resolver, parser: await parser(), folders: [] }, doc, { line: 1, character: 6 });
    assert.ok(list?.items.some((i) => i.label === 'query'));
  });

  it('complétion des variables : celles des fichiers inclus et des appelants', async () => {
    const { doc, resolver } = await setup('<?php\n$local = 1;\n$\n');
    const labels = complete({ resolver, parser: await parser(), folders: [] }, doc, { line: 2, character: 1 })?.items.map((i) => i.label);
    assert.ok(labels?.includes('$pdo') && labels.includes('$site') && labels.includes('$local'));
  });

  it('aller à la définition : affectation dans le fichier inclus', async () => {
    const { doc, lookup, resolver } = await setup("<?php\n$pdo->query('x');\n");
    assert.deepEqual(definition(lookup, doc.symbols, doc.tree, { line: 1, character: 2 }, resolver), [
      { uri: DB, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } } },
    ]);
  });
});
