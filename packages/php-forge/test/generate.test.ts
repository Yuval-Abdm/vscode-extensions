import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CodeAction, TextEdit } from 'vscode-languageserver/node';
import { declaredType, generateActions } from '../src/server/refactor/generate.ts';
import { Lookup } from '../src/server/index/lookup.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { TypeResolver } from '../src/server/types/expand.ts';
import { cursor, extract, parse } from './helpers.ts';

const URI = 'file:///p/a.php';

function apply(text: string, edits: TextEdit[]): string {
  const lines = text.split('\n');
  const offset = (p: { line: number; character: number }) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  let out = text;
  for (const e of [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start))) out = out.slice(0, offset(e.range.start)) + e.newText + out.slice(offset(e.range.end));
  return out;
}

/** Actions au curseur `|` ; `others` : autres fichiers du projet. */
async function actions(code: string, phpVersion = '8.3', others: Record<string, string> = {}): Promise<{ text: string; list: CodeAction[] }> {
  const { text, position } = cursor(code);
  const workspace = new SymbolIndex();
  for (const [name, source] of Object.entries(others)) workspace.set(await extract(source, `file:///p/${name}`));
  const symbols = await extract(text, URI);
  workspace.set(symbols);
  const lookup = new Lookup(workspace, new SymbolIndex());
  const list = generateActions({ uri: URI, text, tree: await parse(text), symbols }, { start: position, end: position }, { lookup, resolver: new TypeResolver(lookup, phpVersion), phpVersion });
  return { text, list };
}

async function run(code: string, title: string, phpVersion = '8.3', others: Record<string, string> = {}): Promise<string> {
  const { text, list } = await actions(code, phpVersion, others);
  const action = list.find((a) => a.title === title);
  assert.ok(action, `${title} absent de ${JSON.stringify(list.map((a) => a.title))}`);
  return apply(text, action.edit!.changes![URI]);
}

describe('getters et setters', () => {
  it('toutes les propriétés sans accesseur, type écrit repris', async () => {
    const code = '<?php\nclass User\n{\n    private ?string $name;\n    protected $age;\n    private static $count;\n\n    public function getAge() { return $this->age; }\n|}\n';
    assert.equal(await run(code, 'Generate getters and setters'), '<?php\nclass User\n{\n    private ?string $name;\n    protected $age;\n    private static $count;\n\n    public function getAge() { return $this->age; }\n\n    public function getName(): ?string\n    {\n        return $this->name;\n    }\n\n    public function setName(?string $name): void\n    {\n        $this->name = $name;\n    }\n\n    public function setAge($age): void\n    {\n        $this->age = $age;\n    }\n}\n');
  });

  it('une propriété ; PHP 5.6 : pas de « : void »', async () => {
    const code = '<?php\nclass User\n{\n    private $na|me;\n}\n';
    assert.equal(await run(code, 'Generate getter and setter for $name', '5.6'), '<?php\nclass User\n{\n    private $name;\n\n    public function getName()\n    {\n        return $this->name;\n    }\n\n    public function setName($name)\n    {\n        $this->name = $name;\n    }\n}\n');
  });

  it('interface ou rien à générer : pas d’action', async () => {
    assert.deepEqual((await actions('<?php\ninterface I\n{\n|}\n')).list.map((a) => a.title), []);
    const done = '<?php\nclass A\n{\n    private bool $on;\n    public function isOn(): bool { return $this->on; }\n    public function setOn(bool $on): void { $this->on = $on; }\n|}\n';
    assert.ok(!(await actions(done)).list.some((a) => a.title.startsWith('Generate getter')));
  });
});

describe('constructeur', () => {
  it('PHP 8 : promotion des propriétés seules et sans doc', async () => {
    const code = '<?php\nclass User\n{\n    private string $name;\n    protected ?Mailer $mailer;\n    private $total = 0;\n|}\n';
    assert.equal(await run(code, 'Generate constructor'), '<?php\nclass User\n{\n    public function __construct(\n        private string $name,\n        protected ?Mailer $mailer,\n    ) {\n    }\n    private $total = 0;\n}\n');
  });

  it('PHP 7 : assignations, inséré après les propriétés', async () => {
    const code = '<?php\nclass User\n{\n    private $name;\n    /** @var int */\n    private $age;\n\n    public function f() {}\n|}\n';
    assert.equal(await run(code, 'Generate constructor', '7.4'), '<?php\nclass User\n{\n    private $name;\n    /** @var int */\n    private $age;\n\n    public function __construct($name, $age)\n    {\n        $this->name = $name;\n        $this->age = $age;\n    }\n\n    public function f() {}\n}\n');
  });

  it('PHP 8 : propriété avec attribut ou sur une ligne partagée → pas de promotion, assignations', async () => {
    const code = '<?php\nclass U\n{\n    #[Column]\n    private string $tag;\n    private readonly string $name;\n    private int $a; private int $b;\n|}\n';
    const out = await run(code, 'Generate constructor');
    assert.equal(out, '<?php\nclass U\n{\n    #[Column]\n    private string $tag;\n    private readonly string $name;\n    private int $a; private int $b;\n\n    public function __construct(string $tag, string $name, int $a, int $b)\n    {\n        $this->tag = $tag;\n        $this->name = $name;\n        $this->a = $a;\n        $this->b = $b;\n    }\n}\n');
  });

  it('PHP 8 : readonly gardé dans la promotion', async () => {
    const out = await run('<?php\nclass U\n{\n    private readonly string $name;\n|}\n', 'Generate constructor');
    assert.equal(out, '<?php\nclass U\n{\n    public function __construct(\n        private readonly string $name,\n    ) {\n    }\n}\n');
  });

  it('classe sur une ligne : code généré dans la classe, PHP valide', async () => {
    for (const title of ['Generate getters and setters', 'Generate constructor']) {
      const out = await run('<?php\nclass A { private $x;| }\n', title, '7.4');
      assert.ok(!(await parse(out)).rootNode.hasError, out);
      assert.match(out, /^<\?php\nclass A \{ private \$x;\n/);
      assert.match(out, /\}\n$/);
    }
  });

  it('constructeur déjà là : pas d’action', async () => {
    assert.ok(!(await actions('<?php\nclass A\n{\n    private $x;\n    public function __construct() {}\n|}\n')).list.some((a) => a.title === 'Generate constructor'));
  });
});

describe('méthodes manquantes', () => {
  it('interface et classe abstraite d’un autre namespace : types en nom complet', async () => {
    const others = { 'lib.php': '<?php\nnamespace Lib;\ninterface Repo\n{\n    public function find(int $id): ?User;\n    public function all();\n}\nabstract class Base implements Repo\n{\n    public function all() { return []; }\n    abstract protected function name(string ...$parts): string;\n}\nclass User {}\n' };
    const code = '<?php\nnamespace App;\n\nuse Lib\\Base;\n\nclass UserRepo extends Base\n{\n|}\n';
    assert.equal(await run(code, 'Implement 2 missing methods', '8.3', others), "<?php\nnamespace App;\n\nuse Lib\\Base;\n\nclass UserRepo extends Base\n{\n    protected function name(string ...$parts): string\n    {\n        throw new \\BadMethodCallException('Not implemented');\n    }\n\n    public function find(int $id): ?\\Lib\\User\n    {\n        throw new \\BadMethodCallException('Not implemented');\n    }\n}\n");
  });

  it('classe abstraite ou tout implémenté : pas d’action', async () => {
    const others = { 'lib.php': '<?php\ninterface I { public function f(); }\n' };
    assert.ok(!(await actions('<?php\nabstract class A implements I\n{\n|}\n', '8.3', others)).list.some((a) => a.title.startsWith('Implement')));
    assert.ok(!(await actions('<?php\nclass A implements I\n{\n    public function f() {}\n|}\n', '8.3', others)).list.some((a) => a.title.startsWith('Implement')));
  });

  it('type écrit : mots-clés tels quels, classes en nom complet, union', () => {
    assert.equal(declaredType('?User', { kind: 'union', types: [{ kind: 'class', fqn: 'Lib\\User' }, { kind: 'scalar', name: 'null' }] }), '?\\Lib\\User');
    assert.equal(declaredType('array', { kind: 'array', list: true, value: { kind: 'scalar', name: 'int' } }), 'array');
    assert.equal(declaredType('int|Foo', { kind: 'union', types: [{ kind: 'scalar', name: 'int' }, { kind: 'class', fqn: 'A\\Foo' }] }), 'int|\\A\\Foo');
    assert.equal(declaredType('self', { kind: 'self' }), 'self');
  });
});

describe('phpdoc et @var', () => {
  it('squelette phpdoc d’une méthode', async () => {
    const code = '<?php\nclass A\n{\n    public function sa|ve(int $id, $data): bool\n    {\n        return true;\n    }\n}\n';
    assert.equal(await run(code, 'Generate PHPDoc'), '<?php\nclass A\n{\n    /**\n     * @param int $id\n     * @param mixed $data\n     * @return bool\n     */\n    public function save(int $id, $data): bool\n    {\n        return true;\n    }\n}\n');
  });

  it('@var d’une variable au type inféré, rien si le type est inconnu', async () => {
    const others = { 'lib.php': '<?php\nnamespace Lib;\nclass User {}\n' };
    const code = '<?php\nfunction f()\n{\n    $u|ser = new \\Lib\\User();\n}\n';
    assert.equal(await run(code, 'Add @var', '8.3', others), '<?php\nfunction f()\n{\n    /** @var \\Lib\\User $user */\n    $user = new \\Lib\\User();\n}\n');
    assert.ok(!(await actions('<?php\n$x| = $_GET["a"];\n')).list.some((a) => a.title === 'Add @var'));
  });
});
