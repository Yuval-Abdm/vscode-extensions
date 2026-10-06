import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tokensOf } from '../src/server/format/tokens.ts';
import { parse } from './helpers.ts';

describe('jetons du formateur', () => {
  it('feuilles de l’arbre ; chaînes, heredoc, commentaires et HTML gardés entiers', async () => {
    const tokens = tokensOf(await parse('<p><?php $a = "x $y"; // c\necho <<<EOT\n  a\nEOT;\n'));
    assert.deepEqual(tokens.map((t) => t.type), ['text', 'php_tag', '$', 'name', '=', 'encapsed_string', ';', 'comment', 'echo', 'heredoc', ';']);
  });

  it('commentaire // : son saut de ligne reste dans l’espace qui suit', async () => {
    const text = '<?php\n// c\necho 1;\n';
    const tokens = tokensOf(await parse(text));
    const comment = tokens.find((t) => t.type === 'comment')!;
    assert.equal(text.slice(comment.start, comment.end), '// c');
    assert.equal(comment.endLine, 1);
  });
});
