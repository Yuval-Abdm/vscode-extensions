import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Lookup } from '../src/server/index/lookup.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { extractFile } from '../src/server/model/extract.ts';
import { bindingAt, TypeResolver } from '../src/server/types/expand.ts';
import { Inferrer } from '../src/server/types/infer.ts';
import { formatType } from '../src/server/types/type.ts';
import { cursor, expressionAt, extract, parse } from './helpers.ts';

const LEGACY = `<?php
namespace App;
class Db {
  private $pdo;
  private $items = [];
  private $name = 'x';
  const MAX = 10;
  public function __construct() { $this->pdo = new \\PDO('dsn'); }
  public function pdo() { return $this->pdo; }
  public function self() { return $this; }
  public function loop() { return $this->loop(); }
  public function items() { return $this->items; }
  public function name() { return $this->name; }
}
class Child extends Db {}
function getDb() { $db = new Db(); return $db; }
function recurse() { return recurse(); }
define('APP_NAME', 'demo');
const LIMIT = 5;
`;

async function typeAt(code: string): Promise<string> {
  const workspace = new SymbolIndex();
  workspace.set(await extract(LEGACY, 'file:///legacy.php'));
  const { text, position } = cursor(code);
  const tree = await parse(text);
  const file = extractFile(tree, 'file:///current.php');
  workspace.set(file);
  const resolver = new TypeResolver(new Lookup(workspace, new SymbolIndex()));
  const node = expressionAt(tree, position);
  return formatType(resolver.expand(new Inferrer(file.scopes).expr(node), bindingAt(node, file.scopes)));
}

describe('types déduits à l’extraction', () => {
  it('propriété affectée dans le constructeur', async () => {
    assert.equal(await typeAt('<?php use App\\Db; $d = new Db(); |$d->pdo();'), 'PDO');
  });

  it('propriétés avec valeur par défaut', async () => {
    assert.equal(await typeAt('<?php use App\\Db; $d = new Db(); |$d->items();'), 'array');
    assert.equal(await typeAt('<?php use App\\Db; $d = new Db(); |$d->name();'), 'string');
  });

  it('return $this : la classe de l’objet', async () => {
    assert.equal(await typeAt('<?php use App\\Child; $c = new Child(); |$c->self();'), 'Child');
  });

  it('fonction qui renvoie une variable locale', async () => {
    assert.equal(await typeAt('<?php use function App\\getDb; |getDb();'), 'Db');
  });

  it('récursion : mixed, sans boucle', async () => {
    assert.equal(await typeAt('<?php use function App\\recurse; |recurse();'), 'mixed');
    assert.equal(await typeAt('<?php use App\\Db; $d = new Db(); |$d->loop();'), 'mixed');
  });

  it('constantes : define, const, constante de classe', async () => {
    assert.equal(await typeAt('<?php |APP_NAME;'), 'string');
    assert.equal(await typeAt('<?php |\\App\\LIMIT;'), 'int');
    assert.equal(await typeAt('<?php use App\\Db; |Db::MAX;'), 'int');
  });

  it('les déclarations typées ne sont pas déduites', async () => {
    const file = await extract('<?php function f(): int { return "x"; } class A { public int $n = 1; }');
    assert.equal(file.symbols[0].inferred, undefined);
    assert.equal(file.symbols[1].children![0].inferred, undefined);
  });
});
