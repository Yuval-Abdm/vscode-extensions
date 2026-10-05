import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { FUNCTIONS, KEYWORDS } from '../src/server/sql/tokens.ts';

const root = path.join(import.meta.dirname, '..');
const grammar = JSON.parse(readFileSync(path.join(root, 'syntaxes/php-sql.injection.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
// Motif entier en (?i:…) : drapeau i de JavaScript (les groupes modificateurs de V8 ratent « or » dans
// FROM|OR|ON|OUTER sous Node 26 ; Oniguruma, utilisé par VS Code, n'a pas ce défaut)
const regex = (source: string) => (source.startsWith('(?i:') && source.endsWith(')') ? new RegExp(source.slice(4, -1), 'i') : new RegExp(source));

describe('grammaire d’injection SQL', () => {
  it('déclarée pour source.php', () => {
    assert.deepEqual(manifest.contributes.grammars, [{ scopeName: 'php-forge.sql-injection', path: './syntaxes/php-sql.injection.json', injectTo: ['source.php'] }]);
    assert.equal(grammar.injectionSelector, 'L:source.php -string -comment');
  });

  it('suite de requête reconnue, texte ordinaire et début de requête laissés à PHP', () => {
    const single = regex(grammar.repository.single.begin);
    for (const s of [`' WHERE id = '`, `'  GROUP BY id ORDER BY nom'`, `' LEFT JOIN t ON a = b'`, `' AND actif = 1'`]) assert.ok(single.test(s), s);
    for (const s of [`'SELECT a FROM t'`, `'Where are you'`, `'ON'`, `'FROMAGE'`, `'from here'`]) assert.ok(!single.test(s), s);
    assert.ok(regex(grammar.repository.double.begin).test(`" WHERE nom = '$nom'"`));
  });

  it('mots-clés et fonctions de la coloration sémantique', () => {
    const [keyword, fn] = grammar.repository.sql.patterns;
    for (const word of KEYWORDS) assert.ok(regex(keyword.match).test(` ${word.toLowerCase()} `), word);
    for (const word of FUNCTIONS) assert.ok(regex(fn.match).test(`${word}(`), word);
    assert.ok(!regex(fn.match).test('COUNT '));
  });
});
