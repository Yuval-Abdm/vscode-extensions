import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Baseline } from '../src/server/diagnostics/baseline.ts';
import { collectDiagnostics, semanticPart, type CollectEnv } from '../src/server/diagnostics/collect.ts';
import { Lookup } from '../src/server/index/lookup.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { TypeResolver } from '../src/server/types/expand.ts';
import { extract, parse, parser } from './helpers.ts';

async function setup(code: string, over: Partial<CollectEnv> = {}) {
  const workspace = new SymbolIndex();
  const symbols = await extract(code, 'file:///p/a.php');
  workspace.set(symbols);
  const env: CollectEnv = {
    parser: await parser(),
    resolver: new TypeResolver(new Lookup(workspace, new SymbolIndex()), '7.4'),
    rules: {},
    library: () => false,
    baseline: () => undefined,
    ...over,
  };
  const input = { uri: 'file:///p/a.php', fsPath: '/p/a.php', symbols, tree: await parse(code), text: code };
  return { env, input };
}

describe('assemblage des diagnostics d’un fichier', () => {
  it('syntaxe, règles sémantiques et code mort réunis, triés', async () => {
    const { env, input } = await setup('<?php\nuse A\\B;\nnope();\n$x = (real)1;\n');
    const result = collectDiagnostics(input, env, semanticPart(input, env));
    assert.deepEqual(result.diagnostics.map((d) => d.code), ['unused-use', 'undefined-function', 'deprecated-syntax']);
    assert.equal(result.hidden, 0);
  });

  it('offset entre accolades : l’erreur de syntaxe laisse la place à la syntaxe dépréciée', async () => {
    const { env, input } = await setup('<?php\necho $s{0};\n');
    const codes = collectDiagnostics(input, env, semanticPart(input, env)).diagnostics.map((d) => d.code);
    assert.deepEqual(codes, ['deprecated-syntax']);
  });

  it('offset entre accolades avant PHP 7.4 : ni erreur de syntaxe ni dépréciation', async () => {
    const { env, input } = await setup('<?php\necho $s{0};\n');
    env.resolver.phpVersion = '7.3';
    assert.deepEqual(collectDiagnostics(input, env, semanticPart(input, env)).diagnostics.map((d) => d.code), []);
  });

  it('librairie : rien ; règle désactivée ; baseline', async () => {
    const lib = await setup('<?php\nnope();\n', { library: () => true });
    assert.deepEqual(collectDiagnostics(lib.input, lib.env, semanticPart(lib.input, lib.env)).diagnostics, []);
    const off = await setup('<?php\nnope();\n', { rules: { 'undefined-function': 'off' } });
    assert.deepEqual(collectDiagnostics(off.input, off.env, semanticPart(off.input, off.env)).diagnostics, []);
    const plain = await setup('<?php\nnope();\n');
    const raw = collectDiagnostics(plain.input, plain.env, semanticPart(plain.input, plain.env)).raw;
    const baseline = Baseline.from([{ rel: 'a.php', diagnostics: raw, text: plain.input.text }]);
    const based = await setup('<?php\nnope();\n', { baseline: () => ({ baseline, rel: 'a.php' }) });
    const result = collectDiagnostics(based.input, based.env, semanticPart(based.input, based.env));
    assert.deepEqual([result.diagnostics.length, result.hidden, result.raw.length], [0, 1, 1]);
  });
});
