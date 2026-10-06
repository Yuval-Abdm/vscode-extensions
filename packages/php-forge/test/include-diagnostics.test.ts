import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import type { FileReport } from '../src/server/includes/analysis.ts';
import { callerLabel, includeDiagnostics, relativePath } from '../src/server/includes/diagnostics.ts';
import { IncludeGraph } from '../src/server/includes/graph.ts';
import { extract } from './helpers.ts';
import { project, uriOf } from './project.ts';

const empty: FileReport = { reads: [], symbols: [], unresolved: [], duplicates: [], approximate: false, contexts: [] };
const label = (via: string) => (via === '' ? '' : via.replace(/^.*?\/p\/(.+)#(\d+|file)$/, (_, f, l) => (l === 'file' ? f : `${f}:${Number(l) + 1}`)));

describe('diagnostics des inclusions', () => {
  it('variable non définie : seule, ou selon les appelants', async () => {
    const file = await extract('<?php echo $title, $x;');
    const report: FileReport = {
      ...empty,
      contexts: ['a', 'b', 'c'],
      reads: [
        { name: 'title', at: [0, 11], end: 17, kind: 'undefined', via: [`${uriOf('lp_3/index.php')}#11`, `${uriOf('lp_9/index.php')}#2`], others: 14 },
        { name: 'x', at: [0, 19], end: 21, kind: 'maybe', via: [''], others: 0 },
      ],
    };
    const [title, x] = includeDiagnostics(report, file, label);
    assert.equal(title.message, '$title is not defined when included from lp_3/index.php:12, lp_9/index.php:3 (defined in 14 other callers)');
    assert.deepEqual([title.code, title.severity, title.range], ['undefined-variable', DiagnosticSeverity.Warning, { start: { line: 0, character: 11 }, end: { line: 0, character: 17 } }]);
    assert.equal(x.message, '$x might not be defined');
    assert.deepEqual([x.code, x.severity], ['maybe-undefined-variable', DiagnosticSeverity.Information]);
  });

  it('plus de trois appelants : les premiers puis le compte', async () => {
    const file = await extract('<?php echo $t;');
    const via = [1, 2, 3, 4, 5].map((n) => `${uriOf(`lp_${n}/index.php`)}#0`);
    const [d] = includeDiagnostics({ ...empty, reads: [{ name: 't', at: [0, 11], end: 13, kind: 'undefined', via, others: 0 }] }, file, label);
    assert.equal(d.message, '$t is not defined when included from lp_1/index.php:1, lp_2/index.php:1, lp_3/index.php:1 and 2 more');
  });

  it('include non résolu ou introuvable, symbole non inclus, analyse approximative', async () => {
    const file = await extract("<?php\ninclude $dyn;\ninclude 'missing.php';\nhelper();\n");
    const report: FileReport = {
      ...empty,
      approximate: true,
      unresolved: [{ index: 0, evaluated: false }, { index: 1, evaluated: true }],
      symbols: [{ need: { kind: 'function', name: 'helper', declaredIn: [uriOf('inc/helpers.php')], at: [3, 0], end: 6 }, via: [''], others: 0 }],
    };
    const diagnostics = includeDiagnostics(report, file, label);
    assert.deepEqual(diagnostics.map((d) => [d.code, d.severity, d.range.start.line]), [
      ['unresolved-include', DiagnosticSeverity.Information, 1],
      ['unresolved-include', DiagnosticSeverity.Information, 2],
      ['symbol-not-included', DiagnosticSeverity.Warning, 3],
      ['include-analysis-approximate', DiagnosticSeverity.Information, 0],
    ]);
    assert.match(String(diagnostics[0].message), /could not be resolved: \$dyn/);
    assert.match(String(diagnostics[1].message), /not found: 'missing\.php'/);
    assert.equal(diagnostics[2].message, 'helper is declared in inc/helpers.php, which is not included here');
  });

  it('libellés : chemin relatif à la racine, ligne à partir de 1', async () => {
    const graph = new IncludeGraph(await project({ 'lp_3/index.php': '<?php' }), { roots: ['/p'], readFile: () => undefined });
    assert.equal(callerLabel(graph, `${uriOf('lp_3/index.php')}#11`), 'lp_3/index.php:12');
    assert.equal(relativePath(graph, uriOf('lp_3/index.php')), 'lp_3/index.php');
  });
  it('déclaration en double', async () => {
    const file = await extract('<?php function helper() {}');
    const [d] = includeDiagnostics({ ...empty, duplicates: [{ name: 'helper', other: uriOf('inc/a.php'), range: { start: { line: 0, character: 15 }, end: { line: 0, character: 21 } }, via: [`${uriOf('lp_3/index.php')}#2`], others: 0 }] }, file, label);
    assert.deepEqual([d.code, d.severity], ['duplicate-declaration', DiagnosticSeverity.Error]);
    assert.equal(d.message, 'helper is already declared in inc/a.php when included from lp_3/index.php:3');
  });
});
