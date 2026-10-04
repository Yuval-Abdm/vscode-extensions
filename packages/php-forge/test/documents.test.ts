import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { syntaxDiagnostics } from '../src/server/diagnostics/syntax.ts';
import { DocumentStore } from '../src/server/documents.ts';
import { parsePhp } from '../src/server/parser/parser.ts';
import type { Range } from '../src/shared/types.ts';
import { parse, parser } from './helpers.ts';

const php = await parser();
const fresh = (text: string) => parsePhp(php, text).rootNode.toString();
const r = (l1: number, c1: number, l2: number, c2: number): Range => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });

describe('DocumentStore', () => {
  it('modifications incrémentales = analyse complète (multiligne, hors BMP)', () => {
    const store = new DocumentStore(php);
    store.open('file:///t.php', 'php', 1, "<?php\nfunction a() {}\n$x = 'é';\n");
    store.change('file:///t.php', 2, [{ range: r(1, 9, 1, 10), text: 'renamed' }]);
    store.change('file:///t.php', 3, [{ range: r(2, 0, 2, 0), text: 'class C {\n  public $p;\n}\n' }]);
    store.change('file:///t.php', 4, [{ range: r(5, 6, 5, 7), text: '😀😀' }]);
    store.change('file:///t.php', 5, [{ range: r(0, 5, 1, 0), text: '\n// note\n' }]);
    const doc = store.get('file:///t.php')!;
    assert.equal(doc.doc.getText(), "<?php\n// note\nfunction renamed() {}\nclass C {\n  public $p;\n}\n$x = '😀😀';\n");
    assert.equal(doc.tree.rootNode.toString(), fresh(doc.doc.getText()));
    assert.deepEqual(doc.symbols.symbols.map((s) => s.name), ['renamed', 'C']);
  });

  it('plusieurs changements dans un même message, puis texte complet', () => {
    const store = new DocumentStore(php);
    store.open('file:///u.php', 'php', 1, '<?php\n');
    store.change('file:///u.php', 2, [{ range: r(1, 0, 1, 0), text: 'function x() {}' }, { range: r(1, 9, 1, 10), text: 'y' }]);
    assert.equal(store.get('file:///u.php')!.doc.getText(), '<?php\nfunction y() {}');
    store.change('file:///u.php', 3, [{ text: '<?php class Z {}' }]);
    const doc = store.get('file:///u.php')!;
    assert.equal(doc.tree.rootNode.toString(), fresh('<?php class Z {}'));
    assert.equal(doc.symbols.symbols[0].name, 'Z');
  });

  it('fermeture', () => {
    const store = new DocumentStore(php);
    store.open('file:///v.php', 'php', 1, '<?php');
    store.close('file:///v.php');
    assert.equal(store.get('file:///v.php'), undefined);
    assert.equal(store.change('file:///v.php', 2, [{ text: '' }]), undefined);
  });
});

describe('syntaxDiagnostics', () => {
  it('aucune erreur sur un fichier valide', async () => assert.deepEqual(syntaxDiagnostics(await parse('<?php echo 1;')), []));

  it('erreur sur une seule ligne, code et source', async () => {
    const diagnostics = syntaxDiagnostics(await parse('<?php\nfunction f( {\n  $a = ;\n}\n'));
    assert.ok(diagnostics.length >= 1);
    for (const d of diagnostics) {
      assert.equal(d.code, 'syntax-error');
      assert.equal(d.severity, DiagnosticSeverity.Error);
      assert.equal(d.source, 'PHP Forge');
      assert.equal(d.range.start.line, d.range.end.line);
    }
    assert.equal(diagnostics[0].range.start.line, 1);
  });

  it('élément manquant', async () => {
    const [first] = syntaxDiagnostics(await parse('<?php\n$a = f(1;'));
    assert.match(String(first.message), /missing "\)"/);
    assert.equal(first.range.start.line, 1);
  });

  it('nombre maximal respecté', async () => {
    assert.equal(syntaxDiagnostics(await parse(`<?php\n${'$a = ;\n'.repeat(20)}`), 5).length, 5);
  });
});
