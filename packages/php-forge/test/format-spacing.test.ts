import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spacing } from '../src/server/format/spacing.ts';
import { tokensOf } from '../src/server/format/tokens.ts';
import { parse } from './helpers.ts';

/** Code PHP d'une ligne réécrit avec les espaces voulus entre ses jetons. */
async function spaced(code: string): Promise<string> {
  const text = `<?php ${code}`;
  const tokens = tokensOf(await parse(text)).slice(1);
  let out = text.slice(tokens[0].start, tokens[0].end);
  for (let i = 1; i < tokens.length; i++) out += spacing(tokens[i - 1], tokens[i], text.slice(tokens[i - 1].end, tokens[i].start)) + text.slice(tokens[i].start, tokens[i].end);
  return out;
}

describe('espaces d’une ligne (PSR-12)', () => {
  it('opérateurs, affectations, virgules, parenthèses', async () => {
    assert.equal(await spaced('$a=1+2*$b.  "x";'), '$a = 1 + 2 * $b . "x";');
    assert.equal(await spaced('foo( $a ,$b )[ 0 ];'), 'foo($a, $b)[0];');
    assert.equal(await spaced('$x .= $y??$z;'), '$x .= $y ?? $z;');
  });

  it('->, ::, unaires, ++, casts, ternaires', async () => {
    assert.equal(await spaced('$o -> m () :: X;'), '$o->m()::X;');
    assert.equal(await spaced('$b = ! $a; $i ++; $n = - 1;'), '$b = !$a; $i++; $n = -1;');
    assert.equal(await spaced('$i=(int)$s;'), '$i = (int) $s;');
    assert.equal(await spaced('$r=$a?$b:$c; $s=$a?:$b;'), '$r = $a ? $b : $c; $s = $a ?: $b;');
  });

  it('mots-clés de contrôle, fonctions, types, arguments nommés', async () => {
    assert.equal(await spaced('if($a){}'), 'if ($a) {}');
    assert.equal(await spaced('foreach($l as $k=>$v){ echo $k;}'), 'foreach ($l as $k => $v) { echo $k; }');
    assert.equal(await spaced('function f(?int &$x=null):int{}'), 'function f(?int &$x = null): int {}');
    assert.equal(await spaced('$f=function($a)use($b){}; $g=fn($x)=>$x;'), '$f = function ($a) use ($b) {}; $g = fn ($x) => $x;');
    assert.equal(await spaced('foo(b:2, ...$r);'), 'foo(b: 2, ...$r);');
    assert.equal(await spaced('$a = array( 1,2 ); unset( $a );'), '$a = array(1, 2); unset($a);');
  });

  it('inconnu : un espace s’il y en avait, aucun sinon ; declare et return gardés', async () => {
    assert.equal(await spaced('declare(strict_types=1);'), 'declare(strict_types=1);');
    assert.equal(await spaced('return ($a);'), 'return ($a);');
    assert.equal(await spaced('echo    $a;'), 'echo $a;');
  });
});
