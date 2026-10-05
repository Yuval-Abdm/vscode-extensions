import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { URI } from 'vscode-uri';
import { IncludeGraph } from '../src/server/includes/graph.ts';
import { impactOf } from '../src/server/includes/impact.ts';
import { indexFileSync } from '../src/server/index/indexFile.ts';
import { listPhpFiles } from '../src/server/index/scan.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { parser } from './helpers.ts';

const ROOT = path.join(import.meta.dirname, 'fixtures/legacy-includes');
const uri = (rel: string) => URI.file(path.join(ROOT, rel)).toString();

describe('impact d’une modification : pages qui atteignent le fichier par inclusion', async () => {
  const p = await parser();
  const index = new SymbolIndex();
  for (const file of await listPhpFiles(ROOT)) {
    const symbols = indexFileSync(p, file, 2_000_000);
    if (symbols) index.set(symbols);
  }
  const graph = new IncludeGraph(index, { roots: [ROOT] });

  it('fichier inclus par une chaîne : toutes les pages qui le chargent, triées', () => {
    const [entry] = impactOf(graph, [uri('includes/fonctions.php')]);
    assert.equal(entry.label, 'includes/fonctions.php');
    assert.deepEqual(entry.pages.map((p) => p.label), ['dynamic.php', 'landing.php', 'lp_1/index.php', 'lp_2/index.php', 'lp_3/index.php']);
    assert.equal(entry.approximate, false);
  });

  it('page modifiée elle-même ; plusieurs fichiers ; fichier inconnu ignoré', () => {
    const entries = impactOf(graph, [uri('lone.php'), uri('includes/header.php'), uri('style.css'), URI.file('/ailleurs/x.php').toString()]);
    assert.deepEqual(entries.map((e) => [e.label, e.pages.map((p) => p.label)]), [
      ['includes/header.php', ['lp_1/index.php', 'lp_2/index.php', 'lp_3/index.php']],
      ['lone.php', ['lone.php']],
    ]);
  });

  it('gabarit inclus par un chemin dynamique : impact approximatif', () => {
    const [entry] = impactOf(graph, [uri('templates/home.php')]);
    assert.equal(entry.approximate, true);
  });
});
