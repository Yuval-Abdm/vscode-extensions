import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { URI } from 'vscode-uri';
import { indexFolder } from '../src/server/index/indexer.ts';
import { SymbolIndex } from '../src/server/index/symbolIndex.ts';
import { applyFileChanges, FileChangeKind, type UpdateContext } from '../src/server/index/updates.ts';
import { parser, wasm } from './helpers.ts';

const php = await parser();
const WORKER = path.join(import.meta.dirname, '../src/server/index/worker.ts');
const uri = (p: string) => URI.file(p).toString();

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'php-forge-updates-'));
  const write = (rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  };
  write('includes/a.php', '<?php class A {}');
  write('includes/b.php', '<?php function b() {}');
  write('cache/c.php', '<?php class C {}');
  return root;
}

const context = (root: string, extra: Partial<UpdateContext> = {}): UpdateContext => ({
  folders: [root], exclude: ['cache'], maxFileSize: 1_000_000, parser: php, wasm, workerScript: WORKER, workers: 0, ...extra,
});

async function indexed(root: string): Promise<SymbolIndex> {
  const index = new SymbolIndex();
  await indexFolder(index, { root, exclude: ['cache'], maxFileSize: 1_000_000, parser: php, wasm, workerScript: WORKER, workers: 0 });
  return index;
}

describe('applyFileChanges', () => {
  it('fichiers modifiés, créés, supprimés ; exclusions respectées', async () => {
    const root = project();
    const index = await indexed(root);
    writeFileSync(path.join(root, 'includes/a.php'), '<?php class A2 {}');
    writeFileSync(path.join(root, 'new.php'), '<?php class N {}');
    rmSync(path.join(root, 'includes/b.php'));
    writeFileSync(path.join(root, 'cache/d.php'), '<?php class D {}');
    const result = await applyFileChanges(index, [
      { uri: uri(path.join(root, 'includes/a.php')), type: FileChangeKind.Changed },
      { uri: uri(path.join(root, 'new.php')), type: FileChangeKind.Created },
      { uri: uri(path.join(root, 'includes/b.php')), type: FileChangeKind.Deleted },
      { uri: uri(path.join(root, 'cache/d.php')), type: FileChangeKind.Created },
    ], context(root));
    assert.deepEqual(result, { indexed: 2, removed: 1 });
    assert.equal(index.findClass('A').length, 0);
    assert.equal(index.findClass('A2').length, 1);
    assert.equal(index.findClass('N').length, 1);
    assert.equal(index.findFunction('b').length, 0);
    assert.equal(index.findClass('D').length, 0);
  });

  it('documents ouverts : laissés tels quels', async () => {
    const root = project();
    const index = await indexed(root);
    const a = path.join(root, 'includes/a.php');
    writeFileSync(a, '<?php class A2 {}');
    await applyFileChanges(index, [{ uri: uri(a), type: FileChangeKind.Changed }], context(root, { isOpen: (u) => u === uri(a) }));
    assert.equal(index.findClass('A').length, 1);
  });

  it('dossier renommé : anciens fichiers retirés, nouveaux indexés', async () => {
    const root = project();
    const index = await indexed(root);
    renameSync(path.join(root, 'includes'), path.join(root, 'lib'));
    await applyFileChanges(index, [
      { uri: uri(path.join(root, 'includes')), type: FileChangeKind.Deleted },
      { uri: uri(path.join(root, 'lib')), type: FileChangeKind.Created },
    ], context(root));
    assert.deepEqual(index.findClass('A').map((h) => h.uri), [uri(path.join(root, 'lib/a.php'))]);
    assert.deepEqual(index.findFunction('b').map((h) => h.uri), [uri(path.join(root, 'lib/b.php'))]);
    assert.ok([...index.files()].every((f) => !f.uri.includes('/includes/')));
  });

  it('gros lot de changements : analysé par les worker threads', async () => {
    const root = project();
    const index = await indexed(root);
    const files = Array.from({ length: 30 }, (_, i) => path.join(root, `gen/f${i}.php`));
    mkdirSync(path.join(root, 'gen'));
    files.forEach((f, i) => writeFileSync(f, `<?php function gen${i}() {}`));
    const result = await applyFileChanges(
      index,
      files.map((f) => ({ uri: uri(f), type: FileChangeKind.Created })),
      context(root, { workers: 2, workerThreshold: 10, workerScript: WORKER }),
    );
    assert.equal(result.indexed, 30);
    assert.equal(index.findFunction('gen29').length, 1);
  });
});
