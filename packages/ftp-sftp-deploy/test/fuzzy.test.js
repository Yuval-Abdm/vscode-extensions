const { describe, it } = require('node:test');
const assert = require('node:assert');
const { fuzzyFilter, fuzzyMatch } = require('../src/fuzzy');

const PATHS = [
  'src/user/UserController.php',
  'src/user/UserRepository.php',
  'public/index.php',
  'config/database.php',
  'src/Controller/HomeController.php',
  'vendor/autoload.php',
];

describe('fuzzyFilter', () => {
  it('lettres dans l’ordre, pas forcément consécutives', () => {
    assert.deepStrictEqual(fuzzyFilter('usctl', PATHS), ['src/user/UserController.php']);
    assert.deepStrictEqual(fuzzyFilter('dtbs', PATHS), ['config/database.php']);
  });

  it('insensible à la casse ; le nom du fichier passe avant le dossier', () => {
    const result = fuzzyFilter('controller', PATHS);
    assert.deepStrictEqual(result.slice(0, 2).sort(), ['src/Controller/HomeController.php', 'src/user/UserController.php']);
    assert.strictEqual(fuzzyFilter('index', PATHS)[0], 'public/index.php');
  });

  it('plusieurs mots : tous doivent correspondre, dans le chemin', () => {
    assert.deepStrictEqual(fuzzyFilter('user repo', PATHS), ['src/user/UserRepository.php']);
    assert.deepStrictEqual(fuzzyFilter('src home', PATHS), ['src/Controller/HomeController.php']);
  });

  it('début du nom préféré à une correspondance au milieu', () => {
    assert.deepStrictEqual(fuzzyFilter('auto', ['src/x/notautomatic.php', 'vendor/autoload.php']), ['vendor/autoload.php', 'src/x/notautomatic.php']);
  });

  it('recherche vide : tout (dans la limite) ; aucune correspondance : rien', () => {
    assert.strictEqual(fuzzyFilter('', PATHS).length, PATHS.length);
    assert.deepStrictEqual(fuzzyFilter('zzz', PATHS), []);
    assert.strictEqual(fuzzyFilter('', PATHS, 2).length, 2);
  });
});

describe('fuzzyMatch', () => {
  it('positions des lettres trouvées, pour les surligner', () => {
    assert.deepStrictEqual(fuzzyMatch('ux', ['src/user/x.php']), [{ path: 'src/user/x.php', positions: [4, 9] }]);
    assert.deepStrictEqual(fuzzyMatch('idx', ['public/index.php'])[0].positions, [7, 9, 11]);
  });
});
