import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { complete } from '../src/server/completion/complete.ts';
import { DocumentStore } from '../src/server/documents.ts';
import { Lookup } from '../src/server/index/lookup.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { TypeResolver } from '../src/server/types/expand.ts';
import { cursor, extract, parser } from './helpers.ts';

const STUBS = '<?php\nfunction mysqli_query($link, string $query) {}\nfunction mysqli_fetch_assoc($result): array|null|false {}\nfunction extract(array &$array): int {}\nclass PDO { public function query(string $q) {} public function prepare(string $q) {} }\nclass PDOStatement { public function fetch(int $mode = 0) {} public function fetchAll(int $mode = 0) {} }\n';

async function labels(code: string): Promise<string[]> {
  const { text, position } = cursor(code);
  const store = new DocumentStore(await parser());
  const doc = store.open('file:///p/page.php', 'php', 1, text);
  const workspace = new SymbolIndex();
  workspace.set(doc.symbols);
  const stubs = new SymbolIndex();
  stubs.set(await extract(STUBS, 'phpstub:/mysqli/mysqli.php'));
  const resolver = new TypeResolver(new Lookup(workspace, stubs), '8.3');
  return complete({ resolver, parser: await parser(), folders: [] }, doc, position)!.items.map((i) => i.label);
}

describe('lignes de résultat typées par le SELECT', () => {
  it('mysqli_fetch_assoc : clés de $row', async () => {
    const code = "<?php\n$res = mysqli_query($db, \"SELECT id, c.nom, COUNT(*) AS total FROM clients c\");\nwhile ($row = mysqli_fetch_assoc($res)) {\n    echo $row['|'];\n}\n";
    const keys = await labels(code);
    for (const key of ['id', 'nom', 'total']) assert.ok(keys.some((k) => k.includes(key)), JSON.stringify(keys));
  });

  it('requête dans une variable, PDO fetch(FETCH_ASSOC) ; extract($row) connaît les colonnes', async () => {
    const code = "<?php\n$sql = 'SELECT prenom, ville FROM clients';\n$stmt = $pdo->query($sql);\n$row = $stmt->fetch(PDO::FETCH_ASSOC);\nextract($row);\necho $vi|;\n";
    const names = await labels(code);
    assert.ok(names.includes('$ville'), JSON.stringify(names));
  });

  it('SELECT * ou mode objet : pas de clés inventées', async () => {
    const code = "<?php\n$res = mysqli_query($db, 'SELECT * FROM clients');\n$row = mysqli_fetch_assoc($res);\necho $row['|'];\n";
    assert.ok(!(await labels(code)).some((k) => /nom|ville/.test(k)));
  });
});
