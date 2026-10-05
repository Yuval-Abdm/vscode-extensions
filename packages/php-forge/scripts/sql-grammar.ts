// Écrit syntaxes/php-sql.injection.json (grammaire d'injection TextMate) à partir des mots-clés et fonctions de la
// coloration sémantique (sql/tokens.ts) : `node scripts/sql-grammar.ts` après les avoir modifiés.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FUNCTIONS, KEYWORDS } from '../src/server/sql/tokens.ts';

/** Clause en majuscules qui commence la suite d'une requête concaténée (les débuts SELECT, INSERT… sont à la grammaire PHP) */
const CLAUSES = String.raw`(?=\s*(?:FROM|WHERE|AND|OR|SET|VALUES|ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT|(?:LEFT|RIGHT|INNER|OUTER|CROSS)\s+JOIN|JOIN|UNION|ON\s+DUPLICATE)\s)`;

const string = (quote: string, name: string, escapes: object[]) => ({
  name,
  begin: quote + CLAUSES,
  end: quote,
  beginCaptures: { 0: { name: 'punctuation.definition.string.begin.php' } },
  endCaptures: { 0: { name: 'punctuation.definition.string.end.php' } },
  patterns: [...escapes, { include: '#sql' }],
});

const grammar = {
  scopeName: 'php-forge.sql-injection',
  injectionSelector: 'L:source.php -string -comment',
  patterns: [{ include: '#single' }, { include: '#double' }],
  repository: {
    single: string("'", 'string.quoted.single.sql.php', [{ name: 'constant.character.escape.php', match: String.raw`\\[\\']` }]),
    double: string('"', 'string.quoted.double.sql.php', [
      { name: 'constant.character.escape.php', match: String.raw`\\(?:[\\"$efnrtv]|[0-7]{1,3}|x[0-9A-Fa-f]{1,2}|u\{[0-9A-Fa-f]+\})` },
      { include: 'source.php#interpolation_double_quoted' },
    ]),
    sql: {
      patterns: [
        { name: 'keyword.other.sql', match: String.raw`(?i:\b(?:${[...KEYWORDS].join('|')})\b)` },
        { name: 'support.function.sql', match: String.raw`(?i:\b(?:${[...FUNCTIONS].join('|')})(?=\s*\())` },
        { name: 'constant.numeric.sql', match: String.raw`\b\d+(?:\.\d+)?\b` },
      ],
    },
  },
};

const out = path.join(import.meta.dirname, '../syntaxes/php-sql.injection.json');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(grammar, null, 2)}\n`);
