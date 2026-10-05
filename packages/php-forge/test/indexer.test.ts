import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CACHE_VERSION, cacheFileFor, loadCache, saveCache } from '../src/server/index/cache.ts';
import { indexFolder, type IndexerOptions } from '../src/server/index/indexer.ts';
import { indexInWorkers } from '../src/server/index/pool.ts';
import { isIndexable, listPhpFiles } from '../src/server/index/scan.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { parser, wasm } from './helpers.ts';

const php = await parser();
const WORKER = path.join(import.meta.dirname, '../src/server/index/worker.ts');

/** Projet temporaire : fichiers normaux, exclus, trop gros, binaire, Latin-1, lien symbolique en boucle. */
function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'php-forge-'));
  const write = (rel: string, content: string | Uint8Array) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  };
  write('a.php', '<?php class A {}');
  write('sub/b.php', '<?php function b() {}');
  write('vendor/lib/x.php', '<?php class Vendor {}');
  write('node_modules/y.php', '<?php class Npm {}');
  write('big.php', `<?php // ${'x'.repeat(5000)}`);
  write('bin.php', Uint8Array.from([0x3c, 0x3f, 0x00, 0x01]));
  write('latin1.php', Uint8Array.from([...Buffer.from('<?php /** Caf'), 0xe9, ...Buffer.from(' */ function cafe() {}')]));
  write('notes.txt', 'pas du PHP');
  symlinkSync(root, path.join(root, 'loop'));
  return root;
}

const options = (root: string, extra: Partial<IndexerOptions> = {}): IndexerOptions => ({
  root, exclude: ['**/vendor/**'], maxFileSize: 1000, parser: php, wasm, workerScript: WORKER, workers: 0, ...extra,
});

describe('parcours des fichiers', () => {
  it('extensions PHP, exclusions, dossiers ignorés, liens symboliques sautés', async () => {
    const root = project();
    const files = (await listPhpFiles(root, ['**/vendor/**'])).map((f) => path.relative(root, f));
    assert.deepEqual(files, ['a.php', 'big.php', 'bin.php', 'latin1.php', path.join('sub', 'b.php')]);
  });

  it('isIndexable applique les exclusions exactement comme le parcours initial', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'php-forge-globs-'));
    for (const rel of ['vendor/a.php', 'cache/b.php', 'src/cache/c.php', 'storage/logs/d.php', 'src/e.php']) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), '<?php');
    }
    for (const exclude of [['vendor'], ['cache'], ['**/cache'], ['storage/logs'], ['**/vendor/**'], ['vendor/**']]) {
      const scanned = new Set(await listPhpFiles(root, exclude));
      for (const rel of ['vendor/a.php', 'cache/b.php', 'src/cache/c.php', 'storage/logs/d.php', 'src/e.php']) {
        const file = path.join(root, rel);
        assert.equal(isIndexable(root, file, exclude), scanned.has(file), `${JSON.stringify(exclude)} ${rel}`);
      }
    }
  });

  it('isIndexable', () => {
    const root = '/projet';
    assert.equal(isIndexable(root, '/projet/a.php', ['**/vendor/**']), true);
    assert.equal(isIndexable(root, '/projet/vendor/lib/x.php', ['**/vendor/**']), false);
    assert.equal(isIndexable(root, '/projet/node_modules/y.php', []), false);
    assert.equal(isIndexable(root, '/projet/notes.txt', []), false);
    assert.equal(isIndexable(root, '/ailleurs/a.php', []), false);
  });
});

describe('indexFolder', () => {
  it('indexe, ignore les fichiers trop gros ou binaires, décode le Latin-1', async () => {
    const index = new SymbolIndex();
    const stats = await indexFolder(index, options(project()));
    assert.deepEqual({ ...stats, ms: 0 }, { files: 5, parsed: 3, fromCache: 0, skipped: 2, syntaxErrors: 0, ms: 0 });
    assert.equal(index.findClass('A').length, 1);
    assert.equal(index.findFunction('b').length, 1);
    assert.equal(index.findFunction('cafe')[0].symbol.doc, 'Café');
  });

  it('réutilise le cache, réanalyse les fichiers modifiés', async () => {
    const root = project();
    const cacheFile = cacheFileFor(mkdtempSync(path.join(tmpdir(), 'php-forge-cache-')), root);
    await indexFolder(new SymbolIndex(), options(root, { cacheFile }));

    const second = await indexFolder(new SymbolIndex(), options(root, { cacheFile }));
    assert.equal(second.fromCache, 3);
    assert.equal(second.parsed, 0);

    writeFileSync(path.join(root, 'a.php'), '<?php class A2 {}');
    const later = new Date(Date.now() + 10_000);
    utimesSync(path.join(root, 'a.php'), later, later);
    const index = new SymbolIndex();
    const third = await indexFolder(index, options(root, { cacheFile }));
    assert.equal(third.parsed, 1);
    assert.equal(third.fromCache, 2);
    assert.equal(index.findClass('A2').length, 1);
  });

  it('cache inchangé : jamais réécrit ; fichier supprimé : réécrit', async () => {
    const root = project();
    const cacheFile = cacheFileFor(mkdtempSync(path.join(tmpdir(), 'php-forge-cache-')), root);
    await indexFolder(new SymbolIndex(), options(root, { cacheFile }));
    const written = statSync(cacheFile).mtimeMs;
    await new Promise((r) => setTimeout(r, 30));
    await indexFolder(new SymbolIndex(), options(root, { cacheFile }));
    assert.equal(statSync(cacheFile).mtimeMs, written);
    rmSync(path.join(root, 'sub/b.php'));
    const after = await indexFolder(new SymbolIndex(), options(root, { cacheFile }));
    assert.equal(after.files, 4);
    assert.notEqual(statSync(cacheFile).mtimeMs, written);
    assert.equal((await indexFolder(new SymbolIndex(), options(root, { cacheFile }))).fromCache, 2);
  });

  it('cache en lignes : version, puis un fichier par ligne (lu et écrit en flux, sans document géant)', async () => {
    const root = project();
    const cacheFile = cacheFileFor(mkdtempSync(path.join(tmpdir(), 'php-forge-cache-')), root);
    await indexFolder(new SymbolIndex(), options(root, { cacheFile }));
    const lines = gunzipSync(readFileSync(cacheFile)).toString('utf8').trimEnd().split('\n');
    assert.deepEqual(JSON.parse(lines[0]), { version: CACHE_VERSION });
    assert.deepEqual(lines.slice(1).map((l) => path.relative(root, JSON.parse(l)[0])).sort(), ['a.php', 'latin1.php', 'sub/b.php']);
  });

  it('écriture du cache impossible (disque plein, dossier en lecture seule) : erreur rendue, pas d’arrêt du processus', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'php-forge-cache-'));
    const cacheFile = path.join(dir, 'index.json.gz');
    // Fichier temporaire impossible à ouvrir : un dossier porte son nom
    mkdirSync(`${cacheFile}.${process.pid}.tmp`);
    const file = { uri: 'file:///p/a.php', symbols: [], includes: [], scopes: [], syntaxError: false, names: ['x'.repeat(200)] };
    const entries = new Map(Array.from({ length: 20_000 }, (_, i) => [`/p/f${i}.php`, { size: 1, mtimeMs: 1, file }] as [string, never]));
    await assert.rejects(saveCache(cacheFile, entries));
    await new Promise((r) => setTimeout(r, 50));
  });

  it('ligne démesurée (ancien cache de plusieurs centaines de Mo sur une ligne) : rejetée sans la lire en entier', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'php-forge-cache-'));
    const cacheFile = path.join(dir, 'index.json.gz');
    const entry = JSON.stringify(['/p/a.php', { size: 1, mtimeMs: 1, file: { uri: 'file:///p/a.php', symbols: [], includes: [], scopes: [], syntaxError: false, names: ['x'.repeat(5000)] } }]);
    writeFileSync(cacheFile, gzipSync(`${JSON.stringify({ version: CACHE_VERSION })}\n${entry}\n`));
    assert.equal((await loadCache(cacheFile, { maxLine: 1000 })).size, 0);
    // En-tête qui ne tient pas sur une ligne courte : ancien format, rejeté dès les premiers octets
    writeFileSync(cacheFile, gzipSync(JSON.stringify({ version: CACHE_VERSION, entries: [['/p/a.php', 'x'.repeat(5000)]] })));
    assert.equal((await loadCache(cacheFile)).size, 0);
  });

  it('cache de l’ancien format (un seul document JSON) : reconstruit', async () => {
    const root = project();
    const cacheFile = path.join(mkdtempSync(path.join(tmpdir(), 'php-forge-cache-')), 'index.json.gz');
    writeFileSync(cacheFile, gzipSync(JSON.stringify({ version: 9, entries: [] })));
    assert.equal((await indexFolder(new SymbolIndex(), options(root, { cacheFile }))).parsed, 3);
    assert.equal((await indexFolder(new SymbolIndex(), options(root, { cacheFile }))).fromCache, 3);
  });

  it('cache corrompu : reconstruit sans erreur', async () => {
    const root = project();
    const cacheFile = path.join(mkdtempSync(path.join(tmpdir(), 'php-forge-cache-')), 'index.json.gz');
    writeFileSync(cacheFile, 'pas du gzip');
    const stats = await indexFolder(new SymbolIndex(), options(root, { cacheFile }));
    assert.equal(stats.parsed, 3);
    assert.equal((await indexFolder(new SymbolIndex(), options(root, { cacheFile }))).fromCache, 3);
  });

  it('worker threads : même résultat', async () => {
    const index = new SymbolIndex();
    const stats = await indexFolder(index, options(project(), { workers: 2, workerThreshold: 1 }));
    assert.equal(stats.parsed, 3);
    assert.equal(index.findFunction('cafe')[0].symbol.doc, 'Café');
  });

  it('worker threads : les fichiers sont analysés par les workers, pas par le repli', async () => {
    const root = project();
    const files = [path.join(root, 'a.php'), path.join(root, 'sub', 'b.php')];
    const results = await indexInWorkers(files, {
      workerScript: WORKER, wasm, maxFileSize: 1000, workers: 2, batchSize: 1,
      fallback: () => { throw new Error('repli utilisé'); },
    });
    assert.deepEqual(files.map((f) => results.get(f)?.symbols[0].name), ['A', 'b']);
  });

  it('worker introuvable : repli dans le thread courant', async () => {
    const stats = await indexFolder(new SymbolIndex(), options(project(), { workers: 2, workerThreshold: 1, workerScript: '/nulle/part/worker.ts' }));
    assert.equal(stats.parsed, 3);
  });
});
