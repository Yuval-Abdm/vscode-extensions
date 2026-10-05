import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import { APPLY_FIX_COMMAND, problemsMarkdown, withProblems } from '../src/server/features/problemHover.ts';
import { syntaxDiagnostics } from '../src/server/diagnostics/syntax.ts';
import { tagDiagnostics } from '../src/server/diagnostics/tags.ts';
import { parse, parser } from './helpers.ts';

const URI = 'file:///a.php';

/** Arguments du lien « Appliquer » (`command:phpForge.applyFix?…`). */
function links(markdown: string) {
  return [...markdown.matchAll(/\]\(command:phpForge\.applyFix\?([^ )]+)/g)].map((m) => JSON.parse(decodeURIComponent(m[1])));
}

describe('survol des problèmes de la ligne', () => {
  it('message, correction proposée et lien pour l’appliquer', async () => {
    const code = '<?php\n$a = 1\n$b = 2;\n';
    const diagnostics = syntaxDiagnostics(await parse(code), 100, { parser: await parser(), text: code });
    const markdown = problemsMarkdown(URI, diagnostics, 1)!;
    assert.match(markdown, /missing ";"/i);
    assert.match(markdown, /Add ";"/);
    assert.equal(APPLY_FIX_COMMAND, 'phpForge.applyFix');
    assert.deepEqual(links(markdown), [[{ uri: URI, edits: [{ range: { start: { line: 1, character: 6 }, end: { line: 1, character: 6 } }, newText: ';' }] }]]);
  });

  it('plusieurs corrections : un lien par correction', async () => {
    const code = '<div><?$nom?></div>';
    const markdown = problemsMarkdown(URI, tagDiagnostics(await parse(code), code), 0)!;
    assert.equal(links(markdown).length, 2);
    assert.match(markdown, /<\?=/);
  });

  it('problème sans correction : message seul', () => {
    const d: Diagnostic = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'boom', severity: DiagnosticSeverity.Error, code: 'syntax-error' };
    const markdown = problemsMarkdown(URI, [d], 0)!;
    assert.match(markdown, /boom/);
    assert.deepEqual(links(markdown), []);
  });

  it('rien sur une ligne sans problème', async () => {
    const code = '<?php\n$a = 1\n$b = 2;\n';
    const diagnostics = syntaxDiagnostics(await parse(code), 100, { parser: await parser(), text: code });
    assert.equal(problemsMarkdown(URI, diagnostics, 2), undefined);
  });

  it('ajouté au survol existant, ou survol à lui seul', () => {
    assert.deepEqual(withProblems(null, undefined), null);
    assert.deepEqual(withProblems(null, 'P'), { contents: { kind: 'markdown', value: 'P' } });
    assert.deepEqual(withProblems({ contents: { kind: 'markdown', value: 'H' } }, 'P'), { contents: { kind: 'markdown', value: 'H\n\n---\n\nP' } });
  });
});
