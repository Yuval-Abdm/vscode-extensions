import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changedFiles, errorSummary, isPhp } from '../src/client/changes.ts';

const change = (path: string, status: number) => ({ uri: { toString: () => `file://${path}`, fsPath: path }, status });

describe('fichiers modifiés et contrôle avant déploiement', () => {
  it('index, arbre de travail, non suivis et conflits ; sans suppression ni doublon ; documents non enregistrés', () => {
    const states = [
      { indexChanges: [change('/p/a.php', 0), change('/p/old.php', 2)], workingTreeChanges: [change('/p/a.php', 5), change('/p/gone.php', 6)], untrackedChanges: [change('/p/new.php', 7)] },
      { mergeChanges: [change('/q/m.php', 16)], indexChanges: [], workingTreeChanges: [change('/q/style.css', 5)] },
    ];
    assert.deepEqual(changedFiles(states, ['file:///p/z.php']), ['file:///p/a.php', 'file:///p/new.php', 'file:///p/z.php', 'file:///q/m.php', 'file:///q/style.css']);
  });

  it('fichiers PHP', () => {
    assert.deepEqual(['a.php', 'b.PHP', 'c.php5', 'd.phtml', 'e.inc', 'f.css', 'g.js'].filter((f) => isPhp(`file:///p/${f}`)), ['a.php', 'b.PHP', 'c.php5', 'd.phtml', 'e.inc']);
  });

  it('résumé des erreurs : rien sans erreur, au plus cinq noms', () => {
    assert.equal(errorSummary([{ label: 'a.php', errors: 0 }]), undefined);
    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((n, i) => ({ label: `${n}.php`, errors: i === 1 ? 0 : 2 }));
    assert.deepEqual(errorSummary(files), { count: 5, names: 'a.php, c.php, d.php, e.php, f.php' });
    assert.deepEqual(errorSummary([...files, { label: 'g.php', errors: 1 }]), { count: 6, names: 'a.php, c.php, d.php, e.php, f.php, …' });
  });
});

describe('API git : désactivée, absente ou en erreur', () => {
  it('jamais d’exception : undefined, et l’activation de PHP Forge continue', async () => {
    const { gitApiOf } = await import('../src/client/changes.ts');
    const api = { repositories: [] };
    assert.equal(await gitApiOf(undefined), undefined);
    assert.equal(await gitApiOf({ isActive: true, exports: { enabled: false, getAPI: () => api }, activate: async () => undefined }), undefined);
    assert.equal(await gitApiOf({ isActive: true, exports: { getAPI: () => { throw new Error('Git model not found'); } }, activate: async () => undefined }), undefined);
    assert.equal(await gitApiOf({ isActive: false, exports: undefined, activate: async () => { throw new Error('activation'); } }), undefined);
    assert.equal(await gitApiOf({ isActive: false, exports: undefined, activate: async () => ({ enabled: true, getAPI: () => api }) }), api);
  });
});

describe('déploiement : fichiers en conflit, confirmation', () => {
  it('fichiers en conflit (fusion) relevés à part', async () => {
    const { conflictedFiles } = await import('../src/client/changes.ts');
    const states = [{ mergeChanges: [change('/p/style.css', 18)], indexChanges: [change('/p/a.php', 0)], workingTreeChanges: [] }];
    assert.deepEqual(conflictedFiles(states), ['file:///p/style.css']);
  });

  it('résumé de confirmation : nombre, profils et serveurs, douze chemins au plus', async () => {
    const { deploySummary } = await import('../src/client/changes.ts');
    const targets = Array.from({ length: 14 }, (_, i) => ({ rel: `f${i}.php`, profile: i < 13 ? 'prod' : 'test', host: i < 13 ? 'ftp.example.org' : 'test.example.org' }));
    assert.deepEqual(deploySummary(targets), { count: 14, servers: ['prod (ftp.example.org)', 'test (test.example.org)'], paths: targets.slice(0, 12).map((t) => t.rel), more: 2 });
    assert.deepEqual(deploySummary([]), { count: 0, servers: [], paths: [], more: 0 });
  });
});
