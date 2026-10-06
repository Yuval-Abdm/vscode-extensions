import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inlayHints } from '../src/server/features/inlayHints.ts';
import { Lookup } from '../src/server/index/lookup.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { extractFile } from '../src/server/model/extract.ts';
import { TypeResolver } from '../src/server/types/expand.ts';
import type { InlayHintSettings } from '../src/shared/protocol.ts';
import { extract, parse } from './helpers.ts';

const LIB = `<?php
namespace Lib;
function helper(int $x, string $label = ''): int {}
class User { public function setName(string $name, bool $notify = false) {} }
`;

const ALL: InlayHintSettings = { parameterNames: true, variableTypes: true, returnTypes: true };

async function hints(code: string, options: Partial<InlayHintSettings> = { parameterNames: true }, lines?: [number, number]) {
  const workspace = new SymbolIndex();
  workspace.set(await extract(LIB, 'file:///lib.php'));
  const tree = await parse(code);
  const file = extractFile(tree, 'file:///current.php');
  workspace.set(file);
  const range = { start: { line: lines?.[0] ?? 0, character: 0 }, end: { line: lines?.[1] ?? 999, character: 0 } };
  const settings = { parameterNames: false, variableTypes: false, returnTypes: false, ...options };
  return inlayHints(new TypeResolver(new Lookup(workspace, new SymbolIndex())), file, tree, range, settings).map((h) => ({
    label: h.label,
    at: `${h.position.line}:${h.position.character}`,
  }));
}

describe('indications inline', () => {
  it('noms des paramètres devant les valeurs littérales', async () => {
    const code = "<?php use function Lib\\helper; helper(5, 'a'); $u = new \\Lib\\User(); $u->setName('bob', true);";
    assert.deepEqual((await hints(code)).map((h) => h.label), ['x:', 'label:', 'name:', 'notify:']);
    assert.equal((await hints(code))[0].at, `0:${code.indexOf('5')}`);
  });

  it('pas pour les variables ni les arguments nommés', async () => {
    assert.deepEqual(await hints('<?php use function Lib\\helper; helper($x); helper(x: 1);'), []);
  });

  it('type des variables (option) : sauf littéraux et new', async () => {
    const code = '<?php use function Lib\\helper; $n = helper(1); $a = 1; $o = new \\Lib\\User();';
    const types = (await hints(code, { variableTypes: true })).map((h) => h.label);
    assert.deepEqual(types, [': int']);
  });

  it('type de retour déduit (option)', async () => {
    const code = '<?php function g() { return 1; }';
    assert.deepEqual(await hints(code, { returnTypes: true }), [{ label: ': int', at: `0:${code.indexOf(')') + 1}` }]);
  });

  it('seulement dans la plage demandée', async () => {
    const code = '<?php use function Lib\\helper;\nhelper(1);\nhelper(2);';
    assert.deepEqual((await hints(code, ALL, [2, 3])).map((h) => h.at), ['2:7']);
  });
});
