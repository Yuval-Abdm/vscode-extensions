import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DocumentHighlightKind, FoldingRangeKind, type SelectionRange } from 'vscode-languageserver/node';
import { foldingRanges } from '../src/server/features/folding.ts';
import { highlights } from '../src/server/features/highlight.ts';
import { implementations } from '../src/server/features/implementation.ts';
import { selectionRanges } from '../src/server/features/selection.ts';
import { Lookup } from '../src/server/index/lookup.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { extractFile } from '../src/server/model/extract.ts';
import { cursor, parse } from './helpers.ts';

describe('implémentations', () => {
  const CODE = `<?php
interface Shape { function area(); }
abstract class Base implements Shape {}
class Square extends Base { function area() {} }
class Big extends Square { function area() {} }
class Other {}`;

  async function lines(marked: string): Promise<number[]> {
    const { text, position } = cursor(marked);
    const tree = await parse(text);
    const file = extractFile(tree, 'file:///shapes.php');
    const workspace = new SymbolIndex();
    workspace.set(file);
    return implementations(new Lookup(workspace, new SymbolIndex()), file, tree, position).map((l) => l.range.start.line).sort();
  }

  it('interface : toutes les classes qui l’implémentent', async () => {
    assert.deepEqual(await lines(CODE.replace('interface Shape', 'interface Sh|ape')), [2, 3, 4]);
  });

  it('classe : ses sous-classes', async () => assert.deepEqual(await lines(CODE.replace('class Square', 'class Squ|are')), [4]));

  it('méthode d’interface : ses implémentations', async () => {
    assert.deepEqual(await lines(CODE.replace('function area(); }', 'function ar|ea(); }')), [3, 4]);
  });
});

describe('surbrillance des occurrences', () => {
  async function marks(marked: string) {
    const { text, position } = cursor(marked);
    return highlights(await parse(text), text, position).map((h) => [h.range.start.character, h.kind]);
  }

  it('variable : sa portée seulement, écriture et lecture', async () => {
    const result = await marks('<?php function f($a) { $a = 1; echo $|a; } $a = 2;');
    assert.deepEqual(result.map((r) => r[1]), [DocumentHighlightKind.Write, DocumentHighlightKind.Write, DocumentHighlightKind.Read]);
  });

  it('fonction : déclaration et appels, sans casse', async () => {
    const result = await marks('<?php function foo() {} fo|o(); FOO();');
    assert.deepEqual(result.map((r) => r[1]), [DocumentHighlightKind.Write, DocumentHighlightKind.Text, DocumentHighlightKind.Text]);
  });

  it('méthode', async () => assert.equal((await marks('<?php class A { function run() { $this->ru|n(); } }')).length, 2));
});

describe('repli', () => {
  it('imports, commentaires, classe, méthode, tableau, région', async () => {
    const tree = await parse(['<?php', 'use A\\B;', 'use C\\D;', '/**', ' * Doc', ' */', 'class X {', '    public function f() {', '        $a = [', '            1,', '        ];', '    }', '}', '// region Outils', 'function g() {}', '// endregion'].join('\n'));
    const ranges = foldingRanges(tree).map((r) => `${r.startLine}-${r.endLine}${r.kind ? `:${r.kind}` : ''}`);
    for (const expected of [`1-2:${FoldingRangeKind.Imports}`, `3-5:${FoldingRangeKind.Comment}`, '6-11', '7-10', '8-9', `13-15:${FoldingRangeKind.Region}`]) {
      assert.ok(ranges.includes(expected), `${expected} absent de ${ranges.join(', ')}`);
    }
  });
});

describe('sélection intelligente', () => {
  it('du littéral à tout le fichier, plages croissantes', async () => {
    const { text, position } = cursor('<?php $x = foo(|1, 2);');
    const [selection] = selectionRanges(await parse(text), [position]);
    const sizes: number[] = [];
    for (let r: SelectionRange | undefined = selection; r; r = r.parent) sizes.push(r.range.end.character - r.range.start.character + r.range.end.line * 1000);
    assert.equal(selection.range.end.character - selection.range.start.character, 1);
    assert.ok(sizes.length >= 5);
    assert.ok(sizes.every((s, i) => i === 0 || s > sizes[i - 1]));
  });
});
