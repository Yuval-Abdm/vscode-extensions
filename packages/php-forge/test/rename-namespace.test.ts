import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WorkspaceEdit } from 'vscode-languageserver/node';
import { renameAt } from '../src/server/refactor/rename.ts';
import { refEnv } from './refactor-env.ts';

function applied(edit: WorkspaceEdit, texts: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    const rel = uri.slice(uri.indexOf('/p/') + 3);
    const lines = texts[rel].split('\n');
    const offset = (p: { line: number; character: number }) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
    let text = texts[rel];
    for (const e of [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start))) text = text.slice(0, offset(e.range.start)) + e.newText + text.slice(offset(e.range.end));
    out[rel] = text;
  }
  return out;
}

describe('renommer un namespace', () => {
  it('déclarations, sous-namespaces, use, noms qualifiés ; pas les chaînes ni les namespaces au préfixe proche', async () => {
    const files = {
      'a.php': '<?php\nnamespace App\\Models;\nclass User {}\n',
      'b.php': '<?php\nnamespace App\\Models\\Legacy;\nclass Old {}\n',
      'c.php': "<?php\nuse App\\Models\\User;\nuse App\\ModelsExtra\\Thing;\n$u = new \\App\\Models\\Legacy\\Old();\necho 'App\\Models\\User';\n",
    };
    const { env, file } = await refEnv(files);
    const edit = renameAt(env, file('a.php'), { line: 1, character: 15 }, 'App\\Domain', () => false) as WorkspaceEdit;
    assert.deepEqual(applied(edit, files), {
      'a.php': '<?php\nnamespace App\\Domain;\nclass User {}\n',
      'b.php': '<?php\nnamespace App\\Domain\\Legacy;\nclass Old {}\n',
      'c.php': "<?php\nuse App\\Domain\\User;\nuse App\\ModelsExtra\\Thing;\n$u = new \\App\\Domain\\Legacy\\Old();\necho 'App\\Models\\User';\n",
    });
  });
});
