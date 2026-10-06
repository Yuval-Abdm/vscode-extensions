import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SourceCache } from '../src/server/refactor/sourceCache.ts';
import { extract, parse } from './helpers.ts';

describe('cache des fichiers analysés pour les recherches', () => {
  it('fichier lu une fois tant que son résumé ne change pas ; le plus ancien libéré au-delà de la capacité', async () => {
    let reads = 0;
    const symbols = await extract('<?php echo 1;', 'file:///a.php');
    const tree = await parse('<?php echo 1;');
    const deleted: string[] = [];
    const cache = new SourceCache(1, (uri) => {
      reads++;
      return { text: '<?php echo 1;', tree: { delete: () => deleted.push(uri) } as unknown as typeof tree };
    });
    const first = cache.get('file:///a.php', symbols)!;
    first.release();
    cache.get('file:///a.php', symbols)!.release();
    assert.equal(reads, 1);
    const changed = { ...symbols };
    cache.get('file:///a.php', changed)!.release();
    assert.equal(reads, 2);
    assert.deepEqual(deleted, ['file:///a.php']);
    cache.get('file:///b.php', symbols)!.release();
    assert.deepEqual(deleted, ['file:///a.php', 'file:///a.php']);
  });

  it('entrée utilisée : jamais libérée avant la fin de son utilisation', async () => {
    const symbols = await extract('<?php echo 1;', 'file:///a.php');
    const deleted: string[] = [];
    const cache = new SourceCache(1, (uri) => ({ text: '', tree: { delete: () => deleted.push(uri) } as never }));
    const a = cache.get('file:///a.php', symbols)!;
    cache.get('file:///b.php', symbols)!.release();
    assert.deepEqual(deleted, []);
    a.release();
    assert.deepEqual(deleted, ['file:///a.php']);
  });
});
