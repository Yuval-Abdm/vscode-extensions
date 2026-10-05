import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Diagnostic } from 'vscode-languageserver/node';
import { WorkspaceDiagnostics, type WorkspaceJob } from '../src/server/diagnostics/workspace.ts';

const diag: Diagnostic = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'x', code: 'x' };

function job(files: string[], results: Record<string, Diagnostic[]>, published: Map<string, number>, open = new Set<string>()): WorkspaceJob {
  return {
    files: () => files,
    skip: (uri) => open.has(uri),
    compute: (uri) => results[uri] ?? [],
    publish: (uri, diagnostics) => published.set(uri, diagnostics.length),
  };
}

describe('diagnostics du workspace en arrière-plan', () => {
  it('publie les fichiers qui ont des alertes, saute les documents ouverts, efface ceux qui n’en ont plus', async () => {
    const runner = new WorkspaceDiagnostics();
    const published = new Map<string, number>();
    await runner.run(job(['a', 'b', 'c'], { a: [diag], c: [diag] }, published, new Set(['c'])), 0);
    assert.deepEqual([...published], [['a', 1]]);
    await runner.run(job(['a', 'b'], {}, published), 0);
    assert.deepEqual([...published], [['a', 0]]);
    assert.deepEqual([...runner.published], []);
  });

  it('une nouvelle passe annule la précédente', async () => {
    const runner = new WorkspaceDiagnostics();
    const published = new Map<string, number>();
    const files = Array.from({ length: 50 }, (_, i) => `f${i}`);
    const results = Object.fromEntries(files.map((f) => [f, [diag]]));
    const first = runner.run(job(files, results, published), 0);
    const second = runner.run(job(['g'], { g: [diag] }, published), 0);
    await Promise.all([first, second]);
    assert.ok(published.size < 51);
    assert.equal(published.get('g'), 1);
  });

  it('effacer : toutes les publications retirées', async () => {
    const runner = new WorkspaceDiagnostics();
    const published = new Map<string, number>();
    await runner.run(job(['a'], { a: [diag] }, published), 0);
    runner.clear((uri) => published.set(uri, 0));
    assert.deepEqual([...published], [['a', 0]]);
  });

  it('un fichier en erreur n’arrête pas la passe', async () => {
    const runner = new WorkspaceDiagnostics();
    const published = new Map<string, number>();
    const errors: string[] = [];
    const base = job(['a', 'b', 'c'], { a: [diag], c: [diag] }, published);
    await runner.run({ ...base, compute: (uri) => { if (uri === 'b') throw new Error('boom'); return base.compute(uri); }, error: (uri) => errors.push(uri) }, 0);
    assert.deepEqual([[...published.keys()], errors], [['a', 'c'], ['b']]);
  });

  it('publication faite ailleurs (document fermé) : effacée par la passe suivante', async () => {
    const runner = new WorkspaceDiagnostics();
    const published = new Map<string, number>();
    runner.record('x', true);
    await runner.run(job(['x'], {}, published), 0);
    assert.deepEqual([...published], [['x', 0]]);
  });
});
