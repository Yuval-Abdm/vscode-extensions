import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IncludeGraph } from '../src/server/includes/graph.ts';
import { includeDefinition, includeLinks, includerLinks, includersLens } from '../src/server/includes/navigation.ts';
import { project, uriOf } from './project.ts';

async function graph() {
  const index = await project({
    'a.php': "<?php\ninclude 'inc/x.php';\ninclude 'inc/x.php';",
    'b.php': "<?php\n\nrequire 'inc/x.php';",
    'inc/x.php': "<?php\ninclude __DIR__ . '/y.php';",
    'inc/y.php': '<?php',
  });
  return { index, graph: new IncludeGraph(index, { roots: ['/p'], readFile: () => undefined }) };
}

describe('navigation des inclusions', () => {
  it('appelants et fichiers inclus', async () => {
    const { graph: g } = await graph();
    assert.deepEqual(includerLinks(g, uriOf('inc/x.php')), [
      { uri: uriOf('a.php'), line: 1, label: 'a.php:2' },
      { uri: uriOf('a.php'), line: 2, label: 'a.php:3' },
      { uri: uriOf('b.php'), line: 2, label: 'b.php:3' },
    ]);
    assert.deepEqual(includeLinks(g, uriOf('inc/x.php')), [{ uri: uriOf('inc/y.php'), line: 0, label: 'inc/y.php' }]);
  });

  it('CodeLens : nombre de fichiers appelants distincts', async () => {
    const { graph: g } = await graph();
    const [lens] = includersLens(g, uriOf('inc/x.php'));
    assert.deepEqual(lens.command, { title: 'Included by 2 files', command: 'phpForge.showIncluders', arguments: [uriOf('inc/x.php')] });
    assert.equal(includersLens(g, uriOf('inc/y.php'))[0].command?.title, 'Included by 1 file');
    assert.deepEqual(includersLens(g, uriOf('a.php')), []);
  });

  it('aller à la définition depuis un include', async () => {
    const { index, graph: g } = await graph();
    const file = index.get(uriOf('inc/x.php'))!;
    assert.deepEqual(includeDefinition(g, file, { line: 1, character: 12 }), [
      { uri: uriOf('inc/y.php'), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
    ]);
    assert.deepEqual(includeDefinition(g, file, { line: 0, character: 2 }), []);
  });
});
