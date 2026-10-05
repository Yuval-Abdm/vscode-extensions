import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { InsertTextFormat, type CompletionItem } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { complete, resolveCompletion } from '../src/server/completion/complete.ts';
import { DocumentStore } from '../src/server/documents.ts';
import { Lookup } from '../src/server/index/lookup.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { TypeResolver } from '../src/server/types/expand.ts';
import { cursor, extract, parser } from './helpers.ts';

const LIB = `<?php
namespace Lib;
/** Utilisateur */
class User {
  public string $name;
  private int $secret;
  protected ?Address $address;
  public static int $count = 0;
  const ROLE = 'admin';
  public function getName(): string {}
  public function setName(string $name, bool $notify = false): static {}
  private function hidden() {}
  public static function find(int $id): ?static {}
}
abstract class Base {}
class Address { public string $city; }
enum Status: string { case Active = 'a'; case Blocked = 'b'; }
function helper(int $x): int {}
function helper_two() {}
const LIB_VERSION = '1';
`;

const STUBS = `<?php
/** Get string length */
function strlen(string $string): int {}
function str_replace($search, $replace, $subject) {}
/** @removed 7.0 */
function mysql_query($query) {}
/** @since 8.0 */
function str_contains(string $haystack, string $needle): bool {}
`;

const php = await parser();

async function completeAt(code: string, options: { version?: string; uri?: string; folders?: string[] } = {}) {
  const workspace = new SymbolIndex();
  workspace.set(await extract(LIB, 'file:///lib.php'));
  const stubs = new SymbolIndex();
  stubs.set(await extract(STUBS, 'phpstub:/standard/s.php'));
  const { text, position } = cursor(code);
  const doc = new DocumentStore(php).open(options.uri ?? 'file:///current.php', 'php', 1, text);
  workspace.set(doc.symbols);
  const resolver = new TypeResolver(new Lookup(workspace, stubs), options.version ?? '8.3');
  return { list: complete({ resolver, parser: php, folders: options.folders ?? [] }, doc, position), resolver };
}

const labels = async (code: string, options?: Parameters<typeof completeAt>[1]) => (await completeAt(code, options)).list.items.map((i) => i.label);
const item = async (code: string, label: string, options?: Parameters<typeof completeAt>[1]) => (await completeAt(code, options)).list.items.find((i) => i.label === label);
const newText = (i: CompletionItem | undefined) => (i?.textEdit && 'newText' in i.textEdit ? i.textEdit.newText : i?.insertText);

describe('complétion des membres', () => {
  it('objet typé : membres publics non statiques', async () => {
    const found = await labels('<?php $u = new \\Lib\\User(); $u->|');
    for (const expected of ['getName', 'setName', 'name']) assert.ok(found.includes(expected), expected);
    for (const hidden of ['secret', 'hidden', 'find', 'count', 'address']) assert.ok(!found.includes(hidden), hidden);
  });

  it('sous-classe : membres protégés visibles, privés non', async () => {
    const found = await labels('<?php class Admin extends \\Lib\\User { function f() { $this->| } }');
    assert.ok(found.includes('address'));
    assert.ok(!found.includes('secret'));
    assert.ok(!found.includes('hidden'));
  });

  it('membres statiques, constantes, class', async () => {
    const found = await labels('<?php \\Lib\\User::|');
    for (const expected of ['find', 'ROLE', '$count', 'class']) assert.ok(found.includes(expected), expected);
    assert.ok(!found.includes('getName'));
  });

  it('cas d’enum', async () => {
    const found = await labels('<?php \\Lib\\Status::|');
    assert.ok(found.includes('Active') && found.includes('Blocked'));
  });

  it('parent:: dans une méthode d’instance : méthodes d’instance aussi', async () => {
    assert.ok((await labels('<?php class Admin extends \\Lib\\User { function getName(): string { return parent::|; } }')).includes('getName'));
  });

  it('méthodes : snippet avec ou sans paramètres', async () => {
    const setName = await item('<?php $u = new \\Lib\\User(); $u->|', 'setName');
    assert.equal(setName?.insertText, 'setName($0)');
    assert.equal(setName?.insertTextFormat, InsertTextFormat.Snippet);
    assert.equal(setName?.command?.command, 'editor.action.triggerParameterHints');
    assert.equal((await item('<?php $u = new \\Lib\\User(); $u->|', 'getName'))?.insertText, 'getName()');
  });
});

describe('complétion des variables', () => {
  it('variables de la portée avec leur type, superglobales, sans l’identifiant factice', async () => {
    const { list } = await completeAt('<?php function f(int $a) { $b = "x"; $|');
    const byLabel = new Map(list.items.map((i) => [i.label, i]));
    assert.equal(byLabel.get('$a')?.labelDetails?.description, 'int');
    assert.equal(byLabel.get('$b')?.labelDetails?.description, 'string');
    assert.ok(byLabel.has('$_GET'));
    assert.ok(![...byLabel.keys()].some((l) => l.includes('PhpForgeCursor')));
  });
});

describe('complétion des noms', () => {
  it('fonctions natives filtrées par version de PHP', async () => {
    const found = await labels('<?php str|');
    assert.ok(found.includes('strlen') && found.includes('str_replace'));
    assert.ok(!(await labels('<?php mysql|', { version: '8.3' })).includes('mysql_query'));
    assert.ok((await labels('<?php mysql|', { version: '5.6' })).includes('mysql_query'));
    assert.ok(!(await labels('<?php str_con|', { version: '7.3' })).includes('str_contains'));
    assert.ok((await labels('<?php str_con|', { version: '8.0' })).includes('str_contains'));
  });

  it('classes : nom court, importée sinon (use ajouté) ; new sans les abstraites', async () => {
    assert.equal(newText(await item('<?php namespace App; use Lib\\User; new Us|', 'User')), 'User');
    const address = await item('<?php namespace App; new Addr|', 'Address');
    assert.equal(newText(address), 'Address');
    assert.match(address?.additionalTextEdits?.[0].newText ?? '', /^use Lib\\Address;/);
    assert.ok(!(await labels('<?php new Bas|')).includes('Base'));
  });

  it('fonctions : snippet et aide aux paramètres', async () => {
    const helper = await item('<?php namespace Lib; help|', 'helper');
    assert.equal(newText(helper), 'helper($0)');
    assert.equal(helper?.command?.command, 'editor.action.triggerParameterHints');
    assert.equal(newText(await item('<?php namespace Lib; help|', 'helper_two')), 'helper_two()');
  });

  it('mots-clés', async () => assert.ok((await labels('<?php fore|')).includes('foreach')));

  it('documentation chargée à la demande', async () => {
    const { list, resolver } = await completeAt('<?php strl|');
    const strlen = resolveCompletion(resolver, list.items.find((i) => i.label === 'strlen')!);
    assert.match(String(strlen.detail), /function strlen/);
    assert.match((strlen.documentation as { value: string }).value, /Get string length/);
  });
});

describe('complétions particulières', () => {
  it('chemins d’include relatifs au fichier ou à la racine', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'php-forge-paths-'));
    mkdirSync(path.join(root, 'includes', 'sub'), { recursive: true });
    writeFileSync(path.join(root, 'includes', 'a.php'), '<?php');
    const uri = URI.file(path.join(root, 'index.php')).toString();
    const relative = await labels("<?php include 'includes/|';", { uri });
    assert.ok(relative.includes('a.php') && relative.includes('sub/'));
    const fromRoot = await labels("<?php include ROOT . '/includes/|';", { uri, folders: [root] });
    assert.ok(fromRoot.includes('a.php'));
  });

  it('clés connues d’un tableau', async () => {
    assert.deepEqual(await labels("<?php $row = ['id' => 1, 'name' => 'x']; $row['|'];"), ['id', 'name']);
  });

  it('balises phpdoc', async () => assert.ok((await labels('<?php /** @pa| */')).includes('@param')));

  it('rien dans une chaîne ordinaire', async () => assert.deepEqual(await labels("<?php echo 'a|';"), []));
});
