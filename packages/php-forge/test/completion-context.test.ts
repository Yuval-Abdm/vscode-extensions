import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { completionContext, unclosedBraces } from '../src/server/completion/context.ts';
import { DocumentStore } from '../src/server/documents.ts';
import { parser } from './helpers.ts';

const php = await parser();

/** Contexte au curseur « | », résumé en valeurs simples (l'arbre est libéré ensuite). */
function context(code: string): Record<string, unknown> {
  const offset = code.indexOf('|');
  const { tree, context } = completionContext(php, code.replace('|', ''), offset);
  const out: Record<string, unknown> = { kind: context.kind };
  if ('prefix' in context) out.prefix = context.prefix;
  if (context.kind === 'name') out.mode = context.mode;
  if (context.kind === 'member') out.object = context.object.text;
  if (context.kind === 'static') {
    out.scope = context.scope.text;
    out.variable = context.variable;
  }
  if (context.kind === 'arrayKey') out.target = context.target.text;
  tree.delete();
  return out;
}

describe('contexte de complétion', () => {
  it('variables', () => assert.deepEqual(context('<?php $us|'), { kind: 'variable', prefix: 'us' }));

  it('membres d’objet, y compris ?-> et en fin de ligne', () => {
    assert.deepEqual(context('<?php $o->na|'), { kind: 'member', prefix: 'na', object: '$o' });
    assert.deepEqual(context('<?php $o?->|'), { kind: 'member', prefix: '', object: '$o' });
    assert.deepEqual(context('<?php $this->a->|\n$x = 1;'), { kind: 'member', prefix: '', object: '$this->a' });
  });

  it('dans une affectation suivie d’autres lignes : membre, statique, new', () => {
    assert.deepEqual(context('<?php function f() {\n  $a = $this->|\n  $c = 1;\n}'), { kind: 'member', prefix: '', object: '$this' });
    assert.deepEqual(context('<?php function f() {\n  $a = $this->get|\n  return $a;\n}'), { kind: 'member', prefix: 'get', object: '$this' });
    assert.deepEqual(context('<?php $a = $b?->|\n$c = 1;'), { kind: 'member', prefix: '', object: '$b' });
    assert.deepEqual(context('<?php $a = $b->c()->|\n$c = 1;'), { kind: 'member', prefix: '', object: '$b->c()' });
    assert.deepEqual(context('<?php $a = Foo::|\n$c = 1;'), { kind: 'static', prefix: '', scope: 'Foo', variable: false });
    assert.deepEqual(context('<?php $a = Foo::$|\n$c = 1;'), { kind: 'static', prefix: '', scope: 'Foo', variable: true });
    assert.deepEqual(context('<?php $a = new Fo|\n$c = 1;'), { kind: 'name', prefix: 'Fo', mode: 'new' });
  });

  it('membres statiques', () => {
    assert.deepEqual(context('<?php Foo::|'), { kind: 'static', prefix: '', scope: 'Foo', variable: false });
    assert.deepEqual(context('<?php Foo::$c|'), { kind: 'static', prefix: 'c', scope: 'Foo', variable: true });
    assert.deepEqual(context('<?php parent::m|();'), { kind: 'static', prefix: 'm', scope: 'parent', variable: false });
  });

  it('noms : new, type, extends, use, expression, nom qualifié', () => {
    assert.deepEqual(context('<?php new Fo|'), { kind: 'name', prefix: 'Fo', mode: 'new' });
    assert.deepEqual(context('<?php function f(Fo| $a) {}'), { kind: 'name', prefix: 'Fo', mode: 'type' });
    assert.deepEqual(context('<?php class A extends B| {}'), { kind: 'name', prefix: 'B', mode: 'class' });
    assert.deepEqual(context('<?php use App\\Mo|;'), { kind: 'name', prefix: 'App\\Mo', mode: 'use' });
    assert.deepEqual(context('<?php str|'), { kind: 'name', prefix: 'str', mode: 'any' });
    assert.deepEqual(context('<?php str|\n$x = 1;'), { kind: 'name', prefix: 'str', mode: 'any' });
    assert.deepEqual(context('<?php if ($a) { str| }'), { kind: 'name', prefix: 'str', mode: 'any' });
    assert.deepEqual(context('<?php echo \\App\\Mo|;'), { kind: 'name', prefix: '\\App\\Mo', mode: 'any' });
  });

  it('chaînes : chemins d’include et clés de tableau', () => {
    assert.deepEqual(context("<?php include 'inc/fo|';"), { kind: 'include', prefix: 'inc/fo' });
    assert.deepEqual(context("<?php include ROOT_PATH . '/inc/|';"), { kind: 'include', prefix: '/inc/' });
    assert.deepEqual(context("<?php $row['na|'];"), { kind: 'arrayKey', prefix: 'na', target: '$row' });
  });

  it('balises phpdoc', () => assert.deepEqual(context('<?php /** @par| */'), { kind: 'docTag', prefix: 'par' }));

  it('rien : commentaire simple, chaîne ordinaire, HTML, nom de déclaration', () => {
    for (const code of ['<?php // @par|', "<?php echo 'te|xt';", '<p>Hel|lo</p>', '<?php class Fo| {}', '<?php function f($a|) {}']) {
      assert.deepEqual(context(code), { kind: 'none' }, code);
    }
  });
});

describe('accolades non fermées', () => {
  it('compte seulement le PHP, hors chaînes et commentaires', () => {
    assert.equal(unclosedBraces("<p>l'école</p><?php function f() {"), 1);
    assert.equal(unclosedBraces("<?php $s = '{'; // {\n/* { */ if ($a) {"), 1);
    assert.equal(unclosedBraces('<style>a { color: red; }</style><?php if ($a) { ?><b>{</b><?php } ?>'), 0);
    assert.equal(unclosedBraces('<?php function f() {}'), 0);
  });
});

describe('analyse incrémentale depuis l’arbre du document', () => {
  it('même arbre et même contexte qu’une analyse complète', () => {
    for (const code of ['<?php function f(int $a) {\n  $b = 1;\n  $b->|\n', '<?php\n$x = new Foo();\n$x->na|\necho 1;', "<p>l'été</p><?php if ($a) { str|"]) {
      const offset = code.indexOf('|');
      const text = code.replace('|', '');
      const doc = new DocumentStore(php).open('file:///t.php', 'php', 1, text);
      const full = completionContext(php, text, offset);
      const incremental = completionContext(php, text, offset, { tree: doc.tree, position: doc.doc.positionAt(offset) });
      assert.equal(incremental.tree.rootNode.toString(), full.tree.rootNode.toString(), code);
      assert.equal(incremental.context.kind, full.context.kind);
      full.tree.delete();
      incremental.tree.delete();
      assert.equal(doc.tree.rootNode.text, text, 'l’arbre du document est intact');
    }
  });
});
