import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DocumentStore } from '../src/server/documents.ts';
import { signatureHelp } from '../src/server/features/signatureHelp.ts';
import { Lookup } from '../src/server/index/lookup.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { TypeResolver } from '../src/server/types/expand.ts';
import { cursor, extract, parser } from './helpers.ts';

const LIB = `<?php
namespace Lib;
class User {
  public function __construct(string $name, int $age = 0) {}
  /**
   * Change le nom.
   * @param string $name Nouveau nom
   */
  public function setName(string $name, bool $notify = false): static {}
}
function helper(int $x, string ...$rest): int {}
`;

const php = await parser();

async function help(code: string) {
  const workspace = new SymbolIndex();
  workspace.set(await extract(LIB, 'file:///lib.php'));
  const stubs = new SymbolIndex();
  stubs.set(await extract('<?php function strlen(string $string): int {}', 'phpstub:/standard/s.php'));
  const { text, position } = cursor(code);
  const doc = new DocumentStore(php).open('file:///current.php', 'php', 1, text);
  workspace.set(doc.symbols);
  return signatureHelp({ resolver: new TypeResolver(new Lookup(workspace, stubs)), parser: php }, doc, position);
}

describe('aide aux paramètres', () => {
  it('fonction : libellé, plages des paramètres, paramètre actif', async () => {
    const result = (await help('<?php use function Lib\\helper; helper(|1);'))!;
    const signature = result.signatures[0];
    assert.equal(signature.label, 'helper(int $x, string ...$rest): int');
    assert.deepEqual(signature.parameters![0].label, [7, 13]);
    assert.equal(result.activeParameter, 0);
  });

  it('argument suivant, et variadique : reste sur le dernier paramètre', async () => {
    assert.equal((await help('<?php use function Lib\\helper; helper(1, |);'))!.activeParameter, 1);
    assert.equal((await help("<?php use function Lib\\helper; helper(1, 'a', 'b', |);"))!.activeParameter, 1);
  });

  it('méthode d’un objet typé : retour static résolu, doc du paramètre', async () => {
    const result = (await help("<?php $u = new \\Lib\\User('a'); $u->setName('x', |);"))!;
    assert.equal(result.signatures[0].label, 'setName(string $name, bool $notify = false): User');
    assert.equal(result.activeParameter, 1);
    assert.equal(result.signatures[0].parameters![0].documentation, 'Nouveau nom');
    assert.equal((result.signatures[0].documentation as { value: string }).value, 'Change le nom.');
  });

  it('argument nommé', async () => {
    assert.equal((await help("<?php $u = new \\Lib\\User('a'); $u->setName(notify: |);"))!.activeParameter, 1);
  });

  it('constructeur', async () => {
    assert.equal((await help('<?php new \\Lib\\User(|);'))!.signatures[0].label, 'User(string $name, int $age = 0)');
  });

  it('appel imbriqué : l’appel le plus proche', async () => {
    assert.match((await help('<?php use function Lib\\helper; helper(strlen(|));'))!.signatures[0].label, /^strlen\(/);
  });

  it('parenthèse non fermée en fin de fichier', async () => {
    assert.equal((await help('<?php use function Lib\\helper;\nhelper(1, |'))!.activeParameter, 1);
  });

  it('hors d’un appel : null', async () => assert.equal(await help('<?php $x = 1|;'), null));
});
