import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_FORMAT, formatEdits, formatText, type FormatOptions } from '../src/server/format/format.ts';
import { tokenStream } from './format-helpers.ts';
import { parse } from './helpers.ts';

async function fmt(code: string, options: Partial<FormatOptions> = {}): Promise<string> {
  const opts = { ...DEFAULT_FORMAT, ...options };
  const out = formatText(await parse(code), code, opts);
  // Garanties : jetons non blancs inchangés, formater deux fois = formater une fois
  assert.equal(out.replace(/\s+/g, ''), code.replace(/\s+/g, ''), 'jetons modifiés');
  assert.deepEqual(await tokenStream(out), await tokenStream(code), 'suite de jetons modifiée');
  assert.equal(formatText(await parse(out), out, opts), out, 'non idempotent');
  return out;
}

describe('formateur', () => {
  it('indentation, accolades PSR-12, suite d’instruction, switch', async () => {
    const code = '<?php\nnamespace App;\nclass A extends B{\npublic function f( $a,$b=1 ) :int{\nif($a==$b){\nreturn $a+$b;\n}\nelse{\n$x=[\n1,\n2\n];\n$q=$db\n->select()\n->where( "a" );\n}\nswitch($a){\ncase 1:\nfoo();\nbreak;\ndefault:\nbar();\n}\nreturn (int)$a?:-1;\n}\n}\n';
    assert.equal(await fmt(code), '<?php\nnamespace App;\nclass A extends B\n{\n    public function f($a, $b = 1): int\n    {\n        if ($a == $b) {\n            return $a + $b;\n        } else {\n            $x = [\n                1,\n                2\n            ];\n            $q = $db\n                ->select()\n                ->where("a");\n        }\n        switch ($a) {\n            case 1:\n                foo();\n                break;\n            default:\n                bar();\n        }\n        return (int) $a ?: -1;\n    }\n}\n');
  });

  it('corps sur une ligne gardé ; closures, try/catch, do/while, syntaxe if: … endif;', async () => {
    const code = '<?php\nfunction g(){ return 1; }\nclass E{}\n$f = function($a)use($b){\nreturn $a;\n};\ntry{\nx();\n}\ncatch(Exception $e){\n}\ndo{\n$i++;\n}while($i<3);\nif ($a) :\n  echo 1;\nelse :\n  echo 3;\nendif;\n';
    assert.equal(await fmt(code), '<?php\nfunction g() { return 1; }\nclass E {}\n$f = function ($a) use ($b) {\n    return $a;\n};\ntry {\n    x();\n} catch (Exception $e) {\n}\ndo {\n    $i++;\n} while ($i < 3);\nif ($a):\n    echo 1;\nelse:\n    echo 3;\nendif;\n');
  });

  it('fichier mêlé de HTML : seuls les blocs PHP, base = indentation de la balise <?php ; <?= normalisé', async () => {
    const code = '<div>\n    <?php if ($a): ?>\n        <p><?=$x?></p>\n    <?php endif; ?>\n    <?php\n    foreach ($list as $i){\n    echo  $i ;\n    }\n    ?>\n</div>\n';
    assert.equal(await fmt(code), '<div>\n    <?php if ($a): ?>\n        <p><?= $x ?></p>\n    <?php endif; ?>\n    <?php\n    foreach ($list as $i) {\n        echo $i;\n    }\n    ?>\n</div>\n');
  });

  it('} else { rejoint sur une ligne qui commence par <?php ; commentaire // qui finit sur ?>', async () => {
    const code = '<?php if ($a) { ?>\n<p>x</p>\n<?php }\nelse { // autre\n$b = 1;\n}\n?>\n<td><?= f(1); //note  ?></td>\n';
    assert.equal(await fmt(code), '<?php if ($a) { ?>\n<p>x</p>\n<?php } else { // autre\n    $b = 1;\n}\n?>\n<td><?= f(1); //note  ?></td>\n');
  });

  it('commentaires /** */ réalignés ; heredoc et chaînes intacts', async () => {
    const code = '<?php\nclass A {\n/**\n   * Doc\n      */\nfunction h() {\n$s = <<<EOT\n  keep   this\nEOT;\n$t = "a    b";\n}\n}\n';
    assert.equal(await fmt(code), '<?php\nclass A\n{\n    /**\n     * Doc\n     */\n    function h()\n    {\n        $s = <<<EOT\n  keep   this\nEOT;\n        $t = "a    b";\n    }\n}\n');
  });

  it('accolades gardées (keep), tabulation, fin de ligne CRLF', async () => {
    assert.equal(await fmt('<?php\nfunction f() {\nreturn 1;\n}\n', { braces: 'keep' }), '<?php\nfunction f() {\n    return 1;\n}\n');
    assert.equal(await fmt('<?php\nif ($a) {\nb();\n}\n', { unit: '\t' }), '<?php\nif ($a) {\n\tb();\n}\n');
    assert.equal(await fmt('<?php\r\nif ($a) {\r\nb();\r\n}\r\n'), '<?php\r\nif ($a) {\r\n    b();\r\n}\r\n');
  });

  it('erreur de syntaxe : rien n’est modifié ; plage : seulement ses lignes', async () => {
    assert.deepEqual(formatEdits(await parse('<?php\nif ($a {\n'), '<?php\nif ($a {\n', DEFAULT_FORMAT), []);
    const code = '<?php\n$a=1;\n$b=2;\n';
    const edits = formatEdits(await parse(code), code, DEFAULT_FORMAT, { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } });
    assert.deepEqual(edits.map((e) => e.range.start.line), [2, 2]);
  });

  it('signes collés : - -$b et + +$b gardent leur espace ; return ++$i aussi', async () => {
    const code = '<?php\n$x = - -$b;\n$y = + +$b;\n$z = - --$b;\n$w = - -1;\nreturn ++$i;\necho --$j;\nif ($a) ++$k;\n';
    assert.equal(await fmt(code), code);
  });

  it('corps sans accolades indentés ; syntaxe for: … endfor; et switch: … endswitch;', async () => {
    const code = '<?php\nif ($a)\nfoo();\nelse\nbar();\nwhile ($b)\n$i++;\nforeach ($l as $x)\necho $x;\nfor ($i = 0; $i < 3; $i++):\nfoo();\nendfor;\nswitch ($a):\ncase 1:\nfoo();\nendswitch;\n';
    assert.equal(await fmt(code), '<?php\nif ($a)\n    foo();\nelse\n    bar();\nwhile ($b)\n    $i++;\nforeach ($l as $x)\n    echo $x;\nfor ($i = 0; $i < 3; $i++):\n    foo();\nendfor;\nswitch ($a):\n    case 1:\n        foo();\nendswitch;\n');
  });
});
