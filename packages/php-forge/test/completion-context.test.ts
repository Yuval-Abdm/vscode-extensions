import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { completionContext, unclosedBraces } from '../src/server/completion/context.ts';
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
