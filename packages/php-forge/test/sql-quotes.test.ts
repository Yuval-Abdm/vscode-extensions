import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node';
import { quickFixes } from '../src/server/features/codeActions.ts';
import { sqlQuoteDiagnostics } from '../src/server/sql/quotes.ts';
import { parse } from './helpers.ts';

const URI = 'file:///a.php';

async function check(code: string): Promise<Diagnostic[]> {
  return sqlQuoteDiagnostics(await parse(code));
}

function apply(code: string, diagnostic: Diagnostic): string {
  const [fix] = quickFixes(URI, [diagnostic]);
  const lines = code.split('\n');
  const offset = (p: { line: number; character: number }) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  const edits = [...(fix.edit?.changes?.[URI] ?? [])].sort((a, b) => offset(b.range.start) - offset(a.range.start));
  let text = code;
  for (const e of edits) text = text.slice(0, offset(e.range.start)) + e.newText + text.slice(offset(e.range.end));
  return text;
}

const text = (code: string, d: Diagnostic) => code.split('\n')[d.range.start.line].slice(d.range.start.character, d.range.end.character);

describe('requête SQL : guillemets PHP mélangés', () => {
  it('commence en simples, continue en doubles (cas du CRM) : tout en doubles, sans échappement', async () => {
    const code = `<?php\n$sql = 'UPDATE villegeo SET d'.$d." = '". addslashes($h) ."' WHERE id_ville = '" . addslashes($s) ."'";`;
    const diagnostics = await check(code);
    // Le morceau à convertir est souligné : convertir les doubles demanderait d'échapper tous les « ' » SQL
    assert.deepEqual(diagnostics.map((d) => text(code, d)), [`'UPDATE villegeo SET d'`]);
    assert.equal(diagnostics[0].code, 'sql-mixed-quotes');
    assert.equal(diagnostics[0].severity, DiagnosticSeverity.Warning);
    assert.match(String(diagnostics[0].message), /"/);
    const fixed = `<?php\n$sql = "UPDATE villegeo SET d".$d." = '". addslashes($h) ."' WHERE id_ville = '" . addslashes($s) ."'";`;
    assert.equal(quickFixes(URI, [diagnostics[0]])[0].title, 'Use double quotes throughout the query');
    assert.equal(apply(code, diagnostics[0]), fixed);
    assert.deepEqual(await check(fixed), []);
  });

  it('autant d’échappements dans les deux sens : guillemets du début', async () => {
    const code = `<?php $s = 'SELECT a FROM t' . " WHERE b = 1";`;
    const [d, ...rest] = await check(code);
    assert.equal(rest.length, 0);
    assert.equal(text(code, d), `" WHERE b = 1"`);
    assert.equal(apply(code, d), `<?php $s = 'SELECT a FROM t' . ' WHERE b = 1';`);
  });

  it('doubles partout, valeurs entourées de guillemets SQL simples : rien', async () => {
    assert.deepEqual(await check(`<?php $s = "SELECT * FROM t WHERE a = '" . $x . "' AND b = '" . $y . "'";`), []);
  });

  it('morceau qui ne fait qu’entourer une variable : rien', async () => {
    assert.deepEqual(await check(`<?php $s = "SELECT * FROM t WHERE a = " . "'" . $x . "'";`), []);
    assert.deepEqual(await check(`<?php $s = "SELECT * FROM t WHERE a = " . '"' . $x . '"' . " AND b IN (" . "'" . $y . "', '" . $z . "')";`), []);
  });

  it('commence en doubles, continue en simples', async () => {
    const code = `<?php $s = "SELECT a FROM t" . ' WHERE b = \\'$x\\'';`;
    const [d, ...rest] = await check(code);
    assert.equal(rest.length, 0);
    assert.equal(text(code, d), `' WHERE b = \\'$x\\''`);
    assert.equal(apply(code, d), `<?php $s = "SELECT a FROM t" . " WHERE b = '\\$x'";`);
  });

  it('interpolation : la requête passe en doubles', async () => {
    const code = `<?php $s = 'SELECT a FROM t' . " WHERE b = $x";`;
    const [d] = await check(code);
    assert.equal(apply(code, d), `<?php $s = "SELECT a FROM t" . " WHERE b = $x";`);
  });

  it('pas de correction si aucun sens de conversion n’est sûr', async () => {
    const code = String.raw`<?php $s = 'SELECT a FROM t WHERE c REGEXP \'\d\'' . " AND b = $x";`;
    const [d] = await check(code);
    assert.equal(d.code, 'sql-mixed-quotes');
    assert.deepEqual(quickFixes(URI, [d]), []);
  });

  it('texte ordinaire mélangé : rien', async () => {
    assert.deepEqual(await check(`<?php $m = 'Bonjour ' . $n . " !";`), []);
  });
});
