import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveLens, symbolLenses } from '../src/server/refactor/codeLens.ts';
import { refEnv } from './refactor-env.ts';

describe('CodeLens des références et implémentations', () => {
  const files = {
    'shape.php': '<?php\ninterface Shape { public function area(); }\nclass Square implements Shape { public function area() { return 1; } }\nfunction helper() {}\n',
    'use.php': '<?php\n$s = new Square();\n$s->area();\nhelper();\nhelper();\n',
  };

  it('une lentille par déclaration ; implémentations pour les interfaces et leurs méthodes', async () => {
    const { file } = await refEnv(files);
    const lenses = symbolLenses(file('shape.php').symbols, { references: true, implementations: true });
    assert.deepEqual(lenses.map((l) => [l.range.start.line, (l.data as { kind: string }).kind]), [
      [1, 'references'], [1, 'implementations'], [1, 'references'], [1, 'implementations'], [2, 'references'], [2, 'references'], [3, 'references'],
    ]);
    assert.deepEqual(symbolLenses(file('shape.php').symbols, { references: false, implementations: false }), []);
  });

  it('titres et commandes', async () => {
    const { env, file } = await refEnv(files);
    const lenses = symbolLenses(file('shape.php').symbols, { references: true, implementations: true });
    const helper = resolveLens(env, lenses[6], file('shape.php'), () => []);
    assert.equal(helper.command?.title, '2 references');
    assert.equal(helper.command?.command, 'phpForge.showReferences');
    const square = resolveLens(env, lenses[4], file('shape.php'), () => []);
    assert.equal(square.command?.title, '1 reference');
    const impl = resolveLens(env, lenses[1], file('shape.php'), () => [{ uri: 'file:///p/shape.php', range: { start: { line: 2, character: 6 }, end: { line: 2, character: 12 } } }]);
    assert.equal(impl.command?.title, '1 implementation');
  });
});
